from pathlib import Path
import sys

ENGINE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE_ROOT))

from jojo_press.services.pdf_preview_service import PdfPreviewService


import pytest


def test_pdf_preview_service_builds_project_page_preview_path() -> None:
    service = PdfPreviewService()

    assert service.get_preview_image_path('book-1', 3) == 'projects/book-1/previews/page-3.png'


@pytest.mark.parametrize('page', [0, -1])
def test_pdf_preview_service_rejects_non_positive_page_numbers(page: int) -> None:
    service = PdfPreviewService()

    with pytest.raises(ValueError, match='page must be greater than or equal to 1'):
        service.get_preview_image_path('book-1', page)


@pytest.mark.parametrize('project_id', ['../other-project', '..\\other-project', 'book/../../other'])
def test_pdf_preview_service_rejects_path_traversal_like_project_ids(project_id: str) -> None:
    service = PdfPreviewService()

    with pytest.raises(ValueError, match='project_id must contain only letters, numbers, underscores, and dashes'):
        service.get_preview_image_path(project_id, 1)
