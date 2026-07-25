from pathlib import Path
import gzip
import sqlite3

from jojo_olds_api.bloomberg_archive_download import (
    derived_image_candidates,
    detect_image_type,
    extract_article,
    image_variant_key,
    initialize_download_schema,
    _image_quality_score,
    pending_articles,
    store_object,
)


ARTICLE_HTML = b"""
<!doctype html>
<html>
  <head>
    <script type="application/ld+json">
      {
        "@type": "NewsArticle",
        "headline": "Archived headline",
        "description": "Archived description",
        "author": [{"name": "One Author"}, {"name": "Two Author"}],
        "datePublished": "2020-01-02T03:04:05Z",
        "image": [
          "https://assets.bwbx.io/images/users/example/photo/v1/1200x800.jpg",
          "https://assets.bwbx.io/s3/javelin/public/social-default.jpg"
        ]
      }
    </script>
  </head>
  <body>
    <article>
      <h1>Fallback headline</h1>
      <div class="body-copy-v2">
        <p>First body paragraph with useful reporting.</p>
        <aside>Share this article</aside>
        <p>Second body paragraph with more reporting.</p>
        <figure>
          <source srcset="
            https://assets.bwbx.io/images/users/example/photo/v1/750x500.jpg 750w,
            https://assets.bwbx.io/images/users/example/photo/v1/488x325.jpg 488w
          ">
        </figure>
      </div>
      <div class="recommendations">
        <img src="https://assets.bwbx.io/images/users/example/related/v1/47x-1.jpg">
      </div>
    </article>
  </body>
</html>
"""


def test_extract_article_body_metadata_and_image_family():
    result = extract_article(ARTICLE_HTML, base_url="https://www.bloomberg.com/example")

    assert result["title"] == "Archived headline"
    assert result["description"] == "Archived description"
    assert result["authors"] == ["One Author", "Two Author"]
    assert "First body paragraph" in result["bodyText"]
    assert "Share this article" not in result["bodyText"]
    assert len(result["imageGroups"]) == 1
    candidates = result["imageGroups"][0]["candidates"]
    assert candidates[0].endswith("/1200x800.jpg")
    assert any(candidate.endswith("/488x325.jpg") for candidate in candidates)


def test_image_variant_key_and_derived_candidates():
    url = "https://assets.bwbx.io/images/users/example/photo/v2/1200x-1.png"
    assert image_variant_key(url).endswith("/{width}x{height}.png")
    candidates = derived_image_candidates([url])
    assert candidates[0] == url
    assert candidates[-1].endswith("/320x-1.png")

    original = (
        "https://assets.bwbx.io/images/users/example/photo/v2/-1x-1.png"
    )
    assert image_variant_key(original) == image_variant_key(url)
    assert derived_image_candidates([original]) == [original]
    assert _image_quality_score(original) > _image_quality_score(url)


def test_image_detection_and_content_addressed_storage(tmp_path: Path):
    content = b"\x89PNG\r\n\x1a\nexample"
    assert detect_image_type(content) == ("image/png", "png")
    first = store_object(
        tmp_path,
        kind="images",
        content=content,
        extension="png",
        compress=False,
    )
    second = store_object(
        tmp_path,
        kind="images",
        content=content,
        extension="png",
        compress=False,
    )
    assert first == second
    assert (tmp_path / first.relative_path).read_bytes() == content

    compressed = store_object(
        tmp_path,
        kind="html",
        content=b"<html>archive</html>",
        extension="html",
        compress=True,
    )
    with gzip.open(tmp_path / compressed.relative_path, "rb") as stream:
        assert stream.read() == b"<html>archive</html>"


def test_download_schema_requires_and_records_authorization():
    connection = sqlite3.connect(":memory:")
    initialize_download_schema(
        connection,
        authorization_reference="license:test",
    )
    assert connection.execute(
        "SELECT value FROM archive_metadata WHERE key='authorization_reference'"
    ).fetchone()[0] == "license:test"


def test_pending_articles_bounds_recovery_attempts_but_not_interrupted_pending():
    connection = sqlite3.connect(":memory:")
    initialize_download_schema(
        connection,
        authorization_reference="license:test",
    )
    rows = [
        ("https://example.com/pending", "pending", 9),
        ("https://example.com/retryable", "error", 2),
        ("https://example.com/exhausted", "partial", 3),
    ]
    connection.executemany(
        """
        INSERT INTO articles(
            url, catalog_date, section, wayback_timestamp,
            wayback_snapshot_url, status, attempts, authorization_reference
        ) VALUES (?, '20200101', 'news', '20200101000000', ?, ?, ?, 'license:test')
        """,
        [
            (url, f"https://web.archive.org/web/20200101000000/{url}", status, attempts)
            for url, status, attempts in rows
        ],
    )

    selected = pending_articles(
        connection,
        retry_errors=True,
        maximum=None,
        maximum_record_attempts=3,
    )

    assert [article.url for article in selected] == [
        "https://example.com/pending",
        "https://example.com/retryable",
    ]
