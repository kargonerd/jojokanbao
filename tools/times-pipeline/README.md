# JOJO Times offline pipeline

Times 不再由浏览器请求触发实时抓取。这个工具把 26 家来源的 RSS 聚合为 JOJO newspaper v1，抓取
文章原始 HTTP 响应并生成 WARC/WACZ，复用 `jojo-news-archive-runner` 锁定的出版方解析器，
最后生成 Canonical、Delivery Jox 和可重建 Elasticsearch 的 JSONL，并按提交顺序发布到 B2。

## 对象布局

```text
jojo-news-raw/
  raw/web-archives/times/YYYY/MM/DD/RUN_ID/times-RUN_ID.wacz
  raw/web-archives/times/YYYY/MM/DD/RUN_ID/run.json
  raw/web-archives/times/state.json.gz
  canonical/news-articles/{publisher}/YYYY/MM/{article-id}-{hash}.json.gz
  canonical/newspapers/times/items/YYYY/MM/YYYY-MM-DD.json.gz

jojo-newspaper/                         # B2 CDN Delivery
  catalog.jox                           # 仅 Times 注册项缺失/变化时更新
  content/newspapers/times/latest.jox
  content/newspapers/times/index.jox
  content/newspapers/times/availability/YYYY.jox
  content/newspapers/times/items/YYYY/MM/YYYY-MM-DD/manifest.jox
  content/newspapers/times/items/YYYY/MM/YYYY-MM-DD/articles/*.jox
```

每个 WACZ 遵循 WACZ 1.2，内部包含 `archive/data.warc.gz`（WARC 1.1 的完整 HTTP
request/response）、`indexes/index.cdx.gz`（CDXJ）、`pages/pages.jsonl`、
`datapackage.json` 和 `datapackage-digest.json`。WARC 与已压缩 CDX 在 ZIP 内使用 STORE，
可以由 ReplayWeb.page 一类工具按 Range 请求回放。鉴权 header、cookie 及 RSSHub key 不写入存档。

Article Jox 是内容寻址的不可变对象；当天 manifest、availability、index 和 latest 是 60 秒
可重新验证的提交标记。发布时先上传 Article，再依次上传这些标记，前端不会读到引用尚未上传
对象的半次发布。全局 `catalog.jox` 只在 Times Dataset 注册项缺失或变化时合并并最后发布，
避免十分钟任务持续改写其他馆藏共用的 Catalog。

流水线默认只接收出版方明确给出发布时间且位于过去 24 小时的条目；缺失时间的条目不会被抓取时间
伪装成新消息。Delivery 和 Canonical 默认保留 7 天。文章页面按 `state.json.gz` 增量轮转，生产任务
使用 Chromium 捕获主文档及同页网络资源，默认每轮最多抓取 50 篇，24 小时刷新成功
页面、2 小时重试失败页面。增量构建复用 `latest.jox` 中已有的内容寻址对象，只生成新增或正文发生变化的
Article。

## 内容边界

`sources.json` 中来源默认使用 `contentPolicy: summary-only`。得到全文存储与再分发授权、且实测
RSSHub 正文与原页一致的来源可单独改为 `feed-body`。公开网页可阅读或 RSS 中出现长文本，不自动
构成把全文重新发布到 CDN 的许可。当前实测见 [FULL_TEXT_AUDIT.md](FULL_TEXT_AUDIT.md)。

生产架构、来源分层、失败边界与分阶段上线计划见 [DESIGN.md](DESIGN.md)。

## 本地构建

```powershell
python -m pip install -r tools/times-pipeline/requirements.txt
$env:JOJOKANBAO_RSSHUB_ACCESS_KEY = "..."
$env:JOJO_NEWS_ARCHIVE_RUNNER_ROOT = "C:\path\to\jojo-news-archive-runner\services\olds-api"
python tools/times-pipeline/run.py --output "$env:TEMP/jojo-times-build"
python -m pytest tools/times-pipeline/tests -q
```

解析器仓库及 13 个 parser version（包括当前未启用来源）由 `runner.lock.json` 锁定；GitHub Action 检出其中记录的精确
commit，并使用 `--require-news-runner` 防止静默退回摘要。单篇解析失败不会丢失 WARC，后续可对
已存档 HTML 离线重跑解析器。

`maintenance-times.yml` 的十分钟发布路径使用 Chromium 增量捕获；手动 `validate-24h` 模式同时保留
全量 HTTP 基线和每源 Chromium 抽样，便于区分 feed、主文档和完整页面资源的故障。
单次页面尝试最多保留主文档和 127 个子资源，正文/header 读取共享 5 秒预算，避免广告和追踪请求
把一次抽检拖到不可控时长。

传入 `--publish` 后，工具会先从 Delivery B2 读取 `latest.jox` 和 `index.jox`，从私有 Raw B2
读取文章抓取状态及保留窗口内的 Canonical，合并已有文章后再发布本次结果。默认 remote 与现有
Content Pipeline 一致：

- `JOJO_RAW_REMOTE=jojo-b2:jojo-news-raw`
- `JOJO_DELIVERY_REMOTE=jojo-b2:jojo-newspaper`

发布时先上传 WACZ 和 Canonical，之后原子推进存档 state，再提交 Delivery 指针。GitHub Actions
负责配置 rclone。流水线各层是显式边界，后续翻译器读取 Canonical、把译文写入
Article `translations`；ES 发布器在同一次运行中直接消费临时的
`search/times/runs/RUN_ID/documents.jsonl.gz`，无需改变前端格式。Search JSONL 不长期上传
B2，Canonical 仍是重建 ES 的唯一真值。
