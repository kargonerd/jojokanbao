from __future__ import annotations

import ast
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1] / "jojo_news_archive"
EXPECTED_AREAS = {
    "capture",
    "discovery",
    "migration",
    "orchestration",
    "parsing",
    "sources",
}


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
