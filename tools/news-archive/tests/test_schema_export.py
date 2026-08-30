from jojo_olds_api.news_models import JojoArticle, RawCapture


def test_public_schema_versions_and_required_fields():
    raw_schema = RawCapture.model_json_schema(by_alias=True)
    article_schema = JojoArticle.model_json_schema(by_alias=True)

    assert "canonicalUrl" in raw_schema["properties"]
    assert "rawHtml" in raw_schema["required"]
    assert "infini-news" in raw_schema["$defs"]["CaptureProvider"]["enum"]
    assert raw_schema["properties"]["representation"]["default"] == "raw-html"
    assert "sourceUrl" in raw_schema["$defs"]["CaptureCandidate"]["properties"]
    assert "bodyHtml" in article_schema["required"]
    assert "blocks" in article_schema["required"]
    assert "images" in article_schema["required"]
    assert "sourceCapture" in article_schema["required"]
