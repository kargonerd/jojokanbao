import gzip
import importlib.util
import json
import sys
from pathlib import Path


TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
MODULE_PATH = TOOLS / "prepare_pdf_periodicals.py"
SPEC = importlib.util.spec_from_file_location("prepare_pdf_periodicals", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def decode_jox(path: Path, object_key: str) -> dict:
    import prepare_rmrb_publication as common
    return json.loads(gzip.decompress(common.transform_jox_bytes(path.read_bytes(), object_key)))


def test_pdf_only_daily_and_issue_publications(tmp_path: Path, monkeypatch) -> None:
    daily = tmp_path / "daily/1957/19570301.pdf"
    issue = tmp_path / "issue/1958/195801.pdf"
    daily.parent.mkdir(parents=True)
    issue.parent.mkdir(parents=True)
    daily.write_bytes(b"%PDF-daily")
    issue.write_bytes(b"%PDF-issue")
    monkeypatch.setattr(MODULE, "PUBLICATIONS", (
        MODULE.Publication("TESTD", "test-daily", "测试日报", "newspaper", "daily", daily.parents[1]),
        MODULE.Publication("TESTI", "test-issue", "测试期刊", "magazine", "issue", issue.parents[1]),
    ))
    output = tmp_path / "output"
    report = MODULE.prepare(MODULE.parser().parse_args(["--output", str(output)]))
    assert report["itemCount"] == 2
    assert (output / "canonical/newspapers/test-daily/assets/pdfs/1957/03/1957-03-01.pdf").read_bytes() == b"%PDF-daily"
    assert (output / "huggingface/newspapers/test-issue/assets/pdfs/1958/195801.pdf").read_bytes() == b"%PDF-issue"
    with gzip.open(output / "canonical/newspapers/test-issue/items/1958/195801.json.gz", "rt", encoding="utf-8") as stream:
        item = json.load(stream)
    assert item["availability"] == {"text": "missing", "pdf": "available"}
    assert item["content"]["articles"] == []
    key = "content/newspapers/test-daily/items/1957/03/1957-03-01/manifest.jox"
    manifest = decode_jox(output / "delivery" / key, key)
    assert manifest["availability"] == {"text": "missing", "pdf": "available"}
    assert manifest["exports"] == []
    assert manifest["assets"][0]["object"] == "assets/issue.pdf.jox"
