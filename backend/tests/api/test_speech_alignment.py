import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("speech_alignment", Path(__file__).resolve().parents[3] / "tools/speech/align.py")
alignment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(alignment)


def test_sentence_offsets_retain_numbers_and_closing_quotes_in_original_text():
    text, sentences = alignment.prepare_sentences('“第2年。 ” 下一句！', lambda value: value.replace("2", "二"))
    assert text == '“第2年。 ” 下一句！'
    assert [sentence["tokens"] for sentence in sentences] == [["第", "二", "年"], ["下", "一", "句"]]
    cues = alignment.sentence_cues(sentences, [[0, 100], [100, 200], [200, 300], [500, 600], [600, 700], [700, 800]], 1)
    assert cues == [dict(start=0, end=.3, startOffset=0, endOffset=6), dict(start=.5, end=.8, startOffset=6, endOffset=10)]


def test_unsupported_spoken_tokens_do_not_silently_shift_alignment():
    with pytest.raises(ValueError, match="normalized Mandarin"):
        alignment.prepare_sentences("读CPU。")
    with pytest.raises(ValueError, match="normalized Mandarin"):
        alignment.prepare_sentences("2018年。")


def test_incomplete_or_invalid_acoustic_output_is_rejected():
    _, sentences = alignment.prepare_sentences("甲。乙。")
    for stamps in ([[0, 100]], [[0, 100], [50, 200]], [[0, 100], [200, 200]], [[0, 100], [200, 2000]]):
        with pytest.raises(ValueError):
            alignment.sentence_cues(sentences, stamps, 1)
