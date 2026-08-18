import importlib.util
import sys
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "backfill_rmrb_peopledata_images.py"
sys.path.insert(0, str(MODULE_PATH.parent))
SPEC = importlib.util.spec_from_file_location("backfill_rmrb_peopledata_images", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def sample_html() -> str:
    return """
    <html><body>
      欢迎您： 浙江大学 <a href="/member/loginout">退出</a>
      <script>var totalRecords = 2;</script>
      <div class="result">
        <h3><a href="/rmrb/pd.html?qs=x19460616&amp;position=0">有正文的稿件</a></h3>
        <a href="/rmrb/19460616/2">【浏览本版】</a>
        <div class="incon_text clearfix"><p class="h60">这是正文摘要。</p></div>
      </div>
      <div class="result">
        <h3><a href="/rmrb/pd.html?qs=x19460616&amp;position=1">麦收</a></h3>
        <a href="/rmrb/19460616/2">【浏览本版】</a>
        <div class="incon_text clearfix">
          <a class="list_pic"><img class="rmrbCover" src="/pic/1946/example.jpg"></a>
          <p class="h60"></p>
        </div>
      </div>
    </body></html>
    """


def test_parse_search_results_detects_only_image_record():
    total, rows = MODULE.parse_search_results(
        sample_html(), "1946-06-16", MODULE.search_url("1946-06-16")
    )
    assert total == 2
    assert [(row["page"], row["ordinal"], row["title"]) for row in rows] == [
        (2, 0, "有正文的稿件"),
        (2, 1, "麦收"),
    ]
    assert rows[0]["summary"] == "这是正文摘要。"
    assert rows[0]["imageUrls"] == []
    assert rows[1]["summary"] == ""
    assert rows[1]["imageUrls"] == [
        f"{MODULE.VPN_ORIGIN}/https/{MODULE.VPN_TARGET}/pic/1946/example.jpg"
    ]


def test_select_result_uses_unique_normalized_title():
    _, rows = MODULE.parse_search_results(
        sample_html(), "1946-06-16", MODULE.search_url("1946-06-16")
    )
    selected, reason = MODULE.select_result(
        {"page": 2, "ordinal": 18, "title": " 麦 收 "}, rows
    )
    assert selected is not None
    assert selected["title"] == "麦收"
    assert reason == "unique_exact_title"


def test_duplicate_title_uses_peopledata_global_position():
    body = sample_html().replace(
        '<h3><a href="/rmrb/pd.html?qs=x19460616&amp;position=0">有正文的稿件</a></h3>',
        '<h3><a href="/rmrb/pd.html?qs=x19460616&amp;position=18">麦收</a></h3>',
    ).replace(
        '<h3><a href="/rmrb/pd.html?qs=x19460616&amp;position=1">麦收</a></h3>',
        '<h3><a href="/rmrb/pd.html?qs=x19460616&amp;position=24">麦收</a></h3>',
    )
    _, rows = MODULE.parse_search_results(
        body, "1946-06-16", MODULE.search_url("1946-06-16")
    )
    selected, reason = MODULE.select_result(
        {"page": 2, "ordinal": 24, "title": "麦收"}, rows
    )
    assert selected is not None
    assert selected["ordinal"] == 24
    assert reason == "exact_title_and_ordinal"


def test_captcha_is_rejected():
    body = "欢迎您：浙江大学 退出 校验验证码 请输入验证码"
    try:
        MODULE.parse_search_results(body, "1946-06-16", MODULE.search_url("1946-06-16"))
    except MODULE.RateLimitError:
        pass
    else:
        raise AssertionError("CAPTCHA response must stop the collector")
