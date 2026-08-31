from __future__ import annotations

import ast
from pathlib import Path
import re


PACKAGE_ROOT = Path(__file__).resolve().parents[1] / "jojo_news_archive"
EXPECTED_AREAS = {
    "capture",
    "discovery",
    "migration",
    "orchestration",
    "parsing",
    "sources",
}
EXPECTED_SOURCES = {
    "aljazeera",
    "ap",
    "axios",
    "bloomberg",
    "caixin",
    "ft",
    "nikkei",
    "npr",
    "nyt",
    "reuters",
    "scmp",
    "wsj",
    "zaobao",
}
SOURCE_ROOT = PACKAGE_ROOT / "sources"


def test_archive_library_has_explicit_feature_areas() -> None:
    root_modules = {path.name for path in PACKAGE_ROOT.glob("*.py")}
    areas = {
        path.name
        for path in PACKAGE_ROOT.iterdir()
        if path.is_dir()
        and not path.name.startswith("__")
        and (path / "__init__.py").is_file()
    }

    assert root_modules == {"__init__.py", "models.py"}
    assert areas == EXPECTED_AREAS
    for area in EXPECTED_AREAS:
        assert (PACKAGE_ROOT / area / "__init__.py").is_file()


def test_archive_library_uses_explicit_absolute_internal_imports() -> None:
    relative_imports: list[str] = []
    stale_flat_imports: list[str] = []
    flat_modules = {
        "archive_sources",
        "bloomberg_archive_download",
        "hf_layout",
        "news_models",
        "news_parser",
        "parser_validation",
        "publisher_specs",
        "raw_archive_capture",
        "wayback_manifest",
    }
    for source in sorted(PACKAGE_ROOT.rglob("*.py")):
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.level:
                relative_imports.append(f"{source.relative_to(PACKAGE_ROOT)}:{node.lineno}")
            imported = ""
            if isinstance(node, ast.ImportFrom):
                imported = node.module or ""
            elif isinstance(node, ast.Import):
                imported = " ".join(alias.name for alias in node.names)
            if any(f"jojo_news_archive.{module}" in imported for module in flat_modules):
                stale_flat_imports.append(
                    f"{source.relative_to(PACKAGE_ROOT)}:{node.lineno}:{imported}"
                )

    assert relative_imports == []
    assert stale_flat_imports == []


def test_each_publisher_is_a_vertical_source_module() -> None:
    source_directories = {
        path.name
        for path in SOURCE_ROOT.iterdir()
        if path.is_dir() and not path.name.startswith("__")
    }

    assert source_directories == EXPECTED_SOURCES
    for source_id in EXPECTED_SOURCES:
        source = SOURCE_ROOT / source_id
        assert (source / "__init__.py").is_file()
        assert (source / "spec.py").is_file()
        assert (source / "parser.py").is_file()
        assert (source / "capture.py").is_file()


def test_shared_code_does_not_import_individual_source_packages() -> None:
    offenders: list[str] = []
    for source in sorted(PACKAGE_ROOT.rglob("*.py")):
        relative = source.relative_to(PACKAGE_ROOT)
        if relative.parts[:1] == ("sources",):
            continue
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        for node in ast.walk(tree):
            module = ""
            if isinstance(node, ast.ImportFrom):
                module = node.module or ""
            elif isinstance(node, ast.Import):
                module = " ".join(alias.name for alias in node.names)
            if any(
                f"jojo_news_archive.sources.{source_id}" in module
                for source_id in EXPECTED_SOURCES
            ):
                offenders.append(f"{relative}:{node.lineno}:{module}")

    assert offenders == []


def test_shared_discovery_contains_no_publisher_policy() -> None:
    discovery_root = PACKAGE_ROOT / "discovery"
    publisher_terms = re.compile(
        r"(?i)(?:\b(?:aljazeera|apnews|axios|bloomberg|caixin|nikkei|npr|"
        r"nytimes|reuters|scmp|wsj|zaobao)\b|"
        r"\b(?:associated press|financial times|new york times|"
        r"wall street journal)\b|\b(?:ap|ft)_(?:syndication|infini|bnn))"
    )
    literals: list[str] = []
    dynamic_imports: list[str] = []
    for source in sorted(discovery_root.rglob("*.py")):
        relative = source.relative_to(PACKAGE_ROOT)
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                if publisher_terms.search(node.value):
                    literals.append(f"{relative}:{node.lineno}:{node.value!r}")
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "import_module"
                and node.args
                and isinstance(node.args[0], ast.Constant)
                and isinstance(node.args[0].value, str)
                and re.search(
                    r"jojo_news_archive\.sources\.[a-z]+(?:\.|$)",
                    node.args[0].value,
                )
            ):
                dynamic_imports.append(
                    f"{relative}:{node.lineno}:{node.args[0].value}"
                )

    assert literals == []
    assert dynamic_imports == []


def test_legacy_publisher_downloader_is_source_owned() -> None:
    shared_client = (PACKAGE_ROOT / "discovery" / "client.py").read_text(
        encoding="utf-8"
    )
    source_downloader = (
        SOURCE_ROOT / "bloomberg" / "legacy_download.py"
    )

    assert source_downloader.is_file()
    assert "def initialize_download_schema(" not in shared_client
    assert "def extract_article(" not in shared_client
    assert "class ManifestArticle" not in shared_client


def test_media_named_implementations_live_under_their_source() -> None:
    offenders: list[str] = []
    for source in sorted(PACKAGE_ROOT.rglob("*.py")):
        relative = source.relative_to(PACKAGE_ROOT)
        if relative.parts[:1] == ("sources",):
            continue
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        for node in tree.body:
            names: list[str] = []
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names = [node.name]
            elif isinstance(node, ast.Assign):
                if (
                    isinstance(node.value, ast.Call)
                    and isinstance(node.value.func, ast.Name)
                    and node.value.func.id in {"_capture_module", "_parser_module"}
                ):
                    continue
                names = [
                    target.id
                    for target in node.targets
                    if isinstance(target, ast.Name)
                ]
            elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                names = [node.target.id]
            for name in names:
                tokens = set(name.strip("_").casefold().split("_"))
                if tokens.intersection(EXPECTED_SOURCES):
                    offenders.append(f"{relative}:{node.lineno}:{name}")

    assert offenders == []


def test_shared_capture_engine_has_no_publisher_policy_branches() -> None:
    """Publisher decisions belong to ``sources/<id>/capture.py`` hooks."""

    source = PACKAGE_ROOT / "capture" / "raw.py"
    tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
    offenders: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Compare):
            continue
        literals = {
            value.value.casefold()
            for value in ast.walk(node)
            if isinstance(value, ast.Constant) and isinstance(value.value, str)
        }
        media = literals.intersection(EXPECTED_SOURCES)
        if media:
            offenders.append(f"raw.py:{node.lineno}:{','.join(sorted(media))}")

    assert offenders == []


def test_legacy_b2_logic_is_quarantined_to_one_time_migration() -> None:
    offenders: list[str] = []
    for source in sorted(PACKAGE_ROOT.rglob("*.py")):
        relative = source.relative_to(PACKAGE_ROOT)
        if relative.parts[:1] == ("migration",):
            continue
        text = source.read_text(encoding="utf-8")
        if "B2_ARCHIVE_" in text or "backblazeb2" in text.casefold():
            offenders.append(str(relative))

    assert offenders == []
