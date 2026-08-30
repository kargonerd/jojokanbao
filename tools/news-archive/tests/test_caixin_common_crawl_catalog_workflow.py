from pathlib import Path
import os
import shutil
import subprocess


REPOSITORY_ROOT = Path(__file__).resolve().parents[1] / "workflow-templates"
WORKFLOW = (
    REPOSITORY_ROOT
    / ".github"
    / "workflows"
    / "caixin-common-crawl-catalog.yml"
)


def _bash_executable() -> str | None:
    """Prefer Git Bash over the WSL shim when tests run on Windows."""
    if os.name == "nt":
        git = shutil.which("git")
        if git:
            git_root = Path(git).resolve().parent.parent
            for candidate in (
                git_root / "usr" / "bin" / "bash.exe",
                git_root / "bin" / "bash.exe",
            ):
                if candidate.is_file():
                    return str(candidate)
    return shutil.which("bash") or shutil.which("bash.exe")


def test_catalog_is_year_parameterized_bounded_and_checkpointed() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert "caixin-common-crawl-${{ inputs.year }}" in workflow
    assert "SAMPLE_YEAR: ${{ inputs.year }}" in workflow
    assert '--from-year "$SAMPLE_YEAR"' in workflow
    assert '--to-year "$SAMPLE_YEAR"' in workflow
    assert 'collection_from_year="$SAMPLE_YEAR"' in workflow
    assert '[ "$collection_from_year" -lt 2012 ]' in workflow
    assert '--collection-from-year "$collection_from_year"' in workflow
    assert "${SAMPLE_YEAR}-${SAMPLE_YEAR}/commoncrawl-prefix" in workflow
    assert '--max-pages "$MAX_PAGES"' in workflow
    assert '--max-queries "$MAX_QUERIES"' in workflow
    assert "checkpoint_capture_state.py" in workflow
    assert "discovery.sqlite3.gz" in workflow
    assert "manifest.jsonl.gz" in workflow
    assert "summarize_archive_manifest.py" in workflow
    assert "manifest-summary.json" in workflow
    assert "--collection-order newest" in workflow
    assert "--collection-order oldest" not in workflow


def test_catalog_auto_continue_preserves_year_and_branch() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    dispatch = workflow[workflow.index("Dispatch next bounded run") :]

    assert "steps.discovery.outputs.should_continue == 'true'" in dispatch
    assert "steps.discovery.outputs.advances != '0'" in dispatch
    assert '--ref "$GITHUB_REF_NAME"' in dispatch
    assert '-f year="$SAMPLE_YEAR"' in dispatch
    assert '-f max_pages="$MAX_PAGES"' in dispatch
    assert '-f max_queries="$MAX_QUERIES"' in dispatch
    assert "auto_continue=true" in dispatch


def test_catalog_run_blocks_have_valid_bash_syntax() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    blocks = []
    lines = workflow.splitlines()
    for index, line in enumerate(lines):
        if line.strip() != "run: |":
            continue
        indent = len(line) - len(line.lstrip())
        body = []
        for candidate in lines[index + 1 :]:
            if candidate.strip() and len(candidate) - len(candidate.lstrip()) <= indent:
                break
            body.append(candidate[indent + 2 :] if candidate.strip() else "")
        blocks.append("\n".join(body))

    assert blocks
    bash = _bash_executable()
    assert bash is not None, "bash is required to validate workflow run blocks"
    for block in blocks:
        result = subprocess.run(
            # Feed the block over stdin instead of passing a Windows path to
            # WSL's ``bash.exe``.  This works with both Git Bash on Windows
            # and the native Bash available on GitHub's Ubuntu runners.
            [bash, "-n"],
            input=block + "\n",
            check=False,
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stderr
