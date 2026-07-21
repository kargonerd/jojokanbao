from copy import deepcopy
from importlib import reload
from json import loads
from pathlib import Path
import sys
import warnings

import pytest
from jsonschema import validate
from pydantic import ValidationError

ENGINE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE_ROOT))

from jojo_press.models.book import Book
import jojo_press.models.book as book_models

PROJECT_ROOT = ENGINE_ROOT


def _load_sample_book() -> dict:
    return loads((PROJECT_ROOT / 'samples' / 'sample_book.json').read_text(encoding='utf-8'))


def _load_book_schema() -> dict:
    return loads((PROJECT_ROOT / 'schema' / 'book.schema.json').read_text(encoding='utf-8'))


def test_book_models_import_without_pydantic_namespace_warnings() -> None:
    with warnings.catch_warnings(record=True) as caught_warnings:
        warnings.simplefilter('always')
        reload(book_models)

    assert not [warning for warning in caught_warnings if 'protected namespace' in str(warning.message)]


def test_sample_book_matches_book_schema() -> None:
    validate(instance=_load_sample_book(), schema=_load_book_schema())


def test_sample_book_instantiates_book_model() -> None:
    sample_book = _load_sample_book()

    book = Book.model_validate(sample_book)

    assert book.book_id == sample_book['book_id']
    assert len(book.content_list) == len(sample_book['content_list'])
    assert len(book.layout) == len(sample_book['layout'])


def test_book_model_rejects_empty_required_strings() -> None:
    sample_book = _load_sample_book()
    sample_book['book_id'] = ''

    with pytest.raises(ValidationError):
        Book.model_validate(sample_book)


@pytest.mark.parametrize(
    ('mutator', 'expected_field'),
    [
        (lambda data: data['source'].__setitem__('page_count', '4'), 'source.page_count'),
        (lambda data: data['content_list'][0].__setitem__('page', '1'), 'content_list.0.page'),
        (lambda data: data['content_list'][0].__setitem__('source_page', 1.5), 'content_list.0.source_page'),
        (lambda data: data['layout'][0].__setitem__('page', '2'), 'layout.0.page'),
        (lambda data: data['layout'][0]['blocks'][0].__setitem__('bbox', ['72', 96, 520, 140]), 'layout.0.blocks.0.bbox.0'),
    ],
)
def test_book_model_rejects_wrong_type_numeric_values(mutator, expected_field: str) -> None:
    sample_book = deepcopy(_load_sample_book())
    mutator(sample_book)

    with pytest.raises(ValidationError) as exc_info:
        Book.model_validate(sample_book)

    assert expected_field in str(exc_info.value)


@pytest.mark.parametrize(
    ('mutator', 'expected_field'),
    [
        (lambda data: data.update({'unexpected': 'value'}), 'unexpected'),
        (lambda data: data['source'].update({'unexpected': 'value'}), 'source.unexpected'),
    ],
)
def test_book_model_rejects_extra_fields(mutator, expected_field: str) -> None:
    sample_book = deepcopy(_load_sample_book())
    mutator(sample_book)

    with pytest.raises(ValidationError) as exc_info:
        Book.model_validate(sample_book)

    assert expected_field in str(exc_info.value)
