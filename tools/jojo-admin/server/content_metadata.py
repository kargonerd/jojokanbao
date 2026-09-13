"""Change publication metadata in an existing build without rebuilding book content."""
from __future__ import annotations

from datetime import datetime, timezone
import gzip
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import re
import sys
from tempfile import TemporaryDirectory
from xml.etree import ElementTree
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "content-pipeline"))
from jojo_format import _decode_jox, _json_bytes, _opaque_name, _transform_jox


def validate_book_title(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 300 or re.search(r"[\x00-\x1f]", value):
        raise ValueError("书名须为 1–300 个字符的单行文字")
    return value.strip()


def _renamed_epub(payload: bytes, title: str) -> bytes:
    output = BytesIO()
    with ZipFile(BytesIO(payload)) as source, ZipFile(output, "w") as target:
        container = ElementTree.fromstring(source.read("META-INF/container.xml"))
        package_path = container.find("{*}rootfiles/{*}rootfile").attrib["full-path"]
        for entry in source.infolist():
            data = source.read(entry)
            if entry.filename == package_path:
                package = ElementTree.fromstring(data)
                element = package.find("{*}metadata/{http://purl.org/dc/elements/1.1/}title")
                if element is None:
                    raise ValueError("EPUB 缺少书名元数据")
                element.text = title
                data = ElementTree.tostring(package, encoding="utf-8", xml_declaration=True)
            target.writestr(entry, data)
    return output.getvalue()


def update_publication(build_root: Path, publication_status: str, access: str, *, title: str | None = None) -> None:
    """Stage all mutable metadata before replacing it; roll back on write failures.

    Chapter bodies and media stay unchanged. A title correction also updates
    search labels and EPUB package metadata, preserving IDs and chapter files.
    Both the canonical tree and the HF mirror must change, since HF uploads the mirror.
    """
    if publication_status not in {"draft", "published"} or access not in {"public", "authenticated"}:
        raise ValueError("无效的发布设置")
    if title is not None:
        title = validate_book_title(title)
    root = build_root.resolve()
    replacements: dict[Path, bytes] = {}

    def local(key: str) -> Path:
        path = (root / key).resolve()
        if not path.is_relative_to(root) or path == root:
            raise ValueError("构建文件路径越出任务目录")
        return path

    source_by_dataset: dict[str, str] = {}
    current_dataset = ""

    def metadata(value: dict) -> dict:
        value["librarySource"] = source_by_dataset.get(value.get("datasetId") or current_dataset, value.get("librarySource") or "jojo")
        value.update(publicationStatus=publication_status, access="authenticated" if value.get("librarySource") == "community" else access)
        if title is not None:
            value["title"] = title
        if "revision" in value:
            value["revision"] += 1
        return value

    def json_file(key: str) -> dict:
        return json.loads(local(key).read_text(encoding="utf-8"))

    def write_jox(key: str, value: dict) -> None:
        replacements[local(f"delivery/{key}")] = _transform_jox(
            gzip.compress(_json_bytes(value), compresslevel=9, mtime=0), key,
        )

    report = json_file("report.json")
    if not report.get("itemsBuilt"):
        raise ValueError("没有可修改的书籍")
    if title is not None and len(report["itemsBuilt"]) != 1:
        raise ValueError("请在单本书籍任务中修改书名")
    dataset_ids = {item["datasetId"] for item in report["itemsBuilt"]}
    for item in report["itemsBuilt"]:
        original = json.loads(gzip.decompress(local(item["canonicalObject"]).read_bytes()))
        provenance = original.get("provenance") or {}
        is_epub = provenance.get("source") == "epub" or provenance.get("sourceFormat") == "epub" or original.get("librarySource") == "community"
        previous = source_by_dataset.get(item["datasetId"])
        source_by_dataset[item["datasetId"]] = "community" if is_epub or previous == "community" else "jojo"
    for item in report["itemsBuilt"]:
        current_dataset = item["datasetId"]
        canonical_path = local(item["canonicalObject"])
        canonical = metadata(json.loads(gzip.decompress(canonical_path.read_bytes())))
        compressed = gzip.compress(_json_bytes(canonical), compresslevel=9, mtime=0)
        replacements[canonical_path] = compressed
        mirror = local(f"huggingface/{item['datasetId']}/data/{item['itemKey']}.json.gz")
        replacements[mirror] = compressed
        key = item["manifestObject"]
        manifest = metadata(_decode_jox(local(f"delivery/{key}"), key))
        manifest["contentStats"]["canonicalCompressedSize"] = len(compressed)
        if title is not None:
            prefix = key.rsplit("/", 1)[0]
            for export in manifest.get("exports", []):
                if export["format"] != "epub":
                    continue
                old_key = f"{prefix}/{export['object']}"
                epub = _renamed_epub(_transform_jox(local(f"delivery/{old_key}").read_bytes(), old_key), title)
                object_name = f"exports/{_opaque_name(epub)}.jox"
                new_key = f"{prefix}/{object_name}"
                replacements[local(f"delivery/{new_key}")] = _transform_jox(epub, new_key)
                export.update(object=object_name, size=len(epub), sha256=hashlib.sha256(epub).hexdigest(),
                              fileName=re.sub(r'[<>:"/\\|?*]', "-", title).rstrip(". ") + ".epub")
            item.update(datasetTitle=title, itemTitle=title)
        write_jox(key, manifest)

    for dataset_id in dataset_ids:
        current_dataset = dataset_id
        for key in (f"canonical/books/{dataset_id}/dataset.json", f"huggingface/{dataset_id}/dataset.json"):
            dataset = metadata(json_file(key))
            for item in dataset.get("items", []):
                metadata(item)
            replacements[local(key)] = _json_bytes(dataset)
        key = f"content/books/{dataset_id}/index.jox"
        index = metadata(_decode_jox(local(f"delivery/{key}"), key))
        for item in index["items"]:
            metadata(item)
        write_jox(key, index)

    catalog = _decode_jox(local("delivery/catalog.jox"), "catalog.jox")
    catalog["revision"] += 1
    catalog["updatedAt"] = datetime.now(timezone.utc).isoformat()
    for dataset in catalog["datasets"]:
        if dataset["datasetId"] in dataset_ids:
            metadata(dataset)
    write_jox("catalog.jox", catalog)

    if title is not None:
        replacements[local("report.json")] = _json_bytes(report)
        documents = []
        for line in gzip.decompress(local("search/documents.jsonl.gz").read_bytes()).splitlines():
            if not line.strip():
                continue
            document = json.loads(line)
            if document.get("datasetId") in dataset_ids:
                document.update(datasetTitle=title, itemTitle=title, revision=document.get("revision", 0) + 1)
            documents.append(_json_bytes(document))
        replacements[local("search/documents.jsonl.gz")] = gzip.compress(b"".join(documents), compresslevel=9, mtime=0)

    # Read every original before writing anything, including the HF mirror.
    originals = {path: path.read_bytes() if path.exists() else None for path in replacements}
    with TemporaryDirectory(prefix=".metadata-", dir=root) as temporary:
        staging = Path(temporary)
        for index, payload in enumerate(replacements.values()):
            (staging / str(index)).write_bytes(payload)
        committed = []
        try:
            for index, path in enumerate(replacements):
                os.replace(staging / str(index), path)
                committed.append(path)
        except OSError:
            for path in reversed(committed):
                if originals[path] is None:
                    path.unlink()
                else:
                    path.write_bytes(originals[path])
            raise
