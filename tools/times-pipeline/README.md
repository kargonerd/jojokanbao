# JOJO Times offline pipeline

Times v2 是 JOJO 看报的离线时事流水线，不提供前端请求触发的抓取 API。完整契约见
[DESIGN.md](DESIGN.md)。

## 当前覆盖

`sources.v2.json` 是 22 家媒体的目录索引；每家媒体的配置位于
`src/sources/{source}/source.json`：AP、The Guardian、Bloomberg、The New York Times、Reuters、
Financial Times、Axios、NPR、Nikkei Asia、联合早报、Al Jazeera、SCMP、新华网、人民网、
中国新闻网、澎湃新闻、财联社、CNA、Deutsche Welle、Focus Taiwan、Africanews、Agência Brasil。
央视新闻已从 v1/v2 目录移除。22 家共配置 153 个选定栏目。
其中 146 个栏目可由轻量发现入口覆盖；Axios 的 5 个栏目与 Bloomberg Asia/AI 共 7 个栏目只保留
出版方目录定义，不参与运行时栏目覆盖率，也不会被错误分类。

发现和正文是两套独立策略：

- JOJO 原生来源适配器：直接调用出版方的轻量入口。来源特例按
  `src/sources/{source}/discover.ts|page.ts|process.ts` 组织；AP、Nikkei、财联社和 DW
  当前使用原生发现器，Reuters 另有页面 URL/正文选择策略。
- 官方 RSS / RSS 列表：直接抓取并保留原始 XML。
- Sitemap：目前用于 Reuters 官方 URL 发现。
- Multi：合并同一媒体的多个选定栏目入口，按文章 ID 去重并保留所有命中的出版方栏目。
- HTML 栏目页适配器：用于 Nikkei 地区页、新华网、人民网大湾区和 Agência Brasil 英文版等没有
  可用 RSS/API 的栏目；可用 CSS selector 只选择文章卡片，避免把导航链接当文章。
- Bloomberg 使用 5 个稳定的官方主题 RSS。Asia/AI 仍保留为出版方栏目链接，但目前没有稳定的轻量
  Feed/API，明确标为仅声明栏目；流水线不会请求分类页，也不会把其他稿件伪标成 Asia/AI。
- Axios 使用官方全文 feed。官网保留 5 个栏目定义和链接，但 feed 不提供可靠栏目字段，因此这些栏目
  明确标为不可分类，不再请求会返回 Cloudflare 403 的栏目 HTML，也不会伪造文章栏目归属。
- 官方内容 API 适配器：澎湃频道直接读取其频道 API 和文章页 `__NEXT_DATA__`，并在发现阶段跳过视频。
- 发现驱动：来源适配器显式声明 `driver: http | browser`。当前 AP 使用 `http`；浏览器 runtime 已作为
  注入接口保留，但尚未给任何生产发现适配器启用，误配会直接失败而不是静默降级。
- `discovery-body`：逐篇质量门槛通过后直接标为全文。
- Chromium（可加载 BPC）：每轮最多 50 个新页面或到期重试页面，生成标准 WARC 1.1/CDXJ/WACZ，并把通过
  通用正文质量门槛的页面回填为全文。
- `discovery-summary`：正文不可用时保留真实摘要，绝不把 metadata-only 伪装成摘要。

同一入口内允许全文与摘要混合，正文质量逐篇判定。栏目健康度按入口是否可用计算；栏目入口正常但
24 小时内没有新稿，不会误报为降级。

AP 是第一条 JOJO 原生完整参考流：4 个栏目只产生 4 次发现请求；候选 URL 再进入统一 Chromium
归档，随后生成按媒体 Canonical 和 B2 格式 Delivery。2026-08-25 的本地两小时回归发现 18 篇，
18/18 页面存档成功、18/18 全文、0 个降级；WACZ 中 18 个主文档均非空。

Axios 的栏目目录不计入运行时栏目健康度；其他支持 URL 前缀推断的栏目即使本轮没有新稿，也不会因
“24 小时内零篇”被误报为实现故障。真正的目标请求失败仍会记录在 source manifest 中。

## 本地运行

Node 需要 `^22.22.2` 或 `^24.15.0`，CI 使用 Node 24.15.0。

```powershell
pnpm install
pnpm --filter @jojo/times-pipeline build

node tools/times-pipeline/dist/src/capture-cli.js `
  --config tools/times-pipeline/sources.v2.json `
  --output "$env:TEMP/jojo-times-v2" `
  --since-hours 24 `
  --workers 4
```

从 capture 输出取得 `runManifest` 后：

```powershell
python tools/times-pipeline/archive_v2.py `
  --config tools/times-pipeline/sources.v2.json `
  --output "$env:TEMP/jojo-times-v2" `
  --run-manifest "<runManifest>" `
  --engine browser `
  --max-pages 50

node tools/times-pipeline/dist/src/process-cli.js `
  --config tools/times-pipeline/sources.v2.json `
  --output "$env:TEMP/jojo-times-v2" `
  --run-manifest "<runManifest>" `
  --raw-revision local

node tools/times-pipeline/dist/src/delivery-cli.js `
  --config tools/times-pipeline/sources.v2.json `
  --output "$env:TEMP/jojo-times-v2" `
  --run-manifest "<runManifest>" `
  --delivery-output "$env:TEMP/jojo-times-delivery"
```

本地查看 Delivery：

```powershell
pnpm --filter @jojo/times-pipeline serve -- `
  --root "$env:TEMP/jojo-times-delivery" `
  --port 4184
```

## 数据布局

Raw 与 Canonical 位于同一个私有 Hugging Face Dataset：

```text
raw/news/{source}/YYYY/MM/DD/{RUN_ID}/
├─ manifest.json
├─ discovery.json.gz
├─ candidates.jsonl.gz
└─ network/
   ├─ exchanges.jsonl.gz
   └─ bodies/{sha256}.bin.gz

raw/news/runs/YYYY/MM/DD/{RUN_ID}.json
raw/web-archives/times/state.json.gz
raw/web-archives/times/YYYY/MM/DD/{RUN_ID}/
├─ run.json
└─ times-{RUN_ID}.wacz

canonical/news/{source}/
├─ dataset.json
└─ articles/YYYY/MM/YYYY-MM-DD.jsonl.gz
```

B2 只保存 Delivery：

```text
catalog.jox
content/newspapers/times/
├─ index.jox
└─ items/YYYY/MM/YYYY-MM-DD/
   ├─ manifest.jox
   └─ articles/{opaque-content-id}.jox
```

日期 manifest、index 和 catalog 是短缓存可变指针；正文对象按内容寻址并使用 immutable 缓存。
Delivery 构建会合并旧 index，所以滚动历史不会在下一轮消失。不存在 `latest.jox`。

## GitHub Actions

- `maintenance-times-capture.yml`：每 10 分钟发现媒体、最多归档 50 个 Chromium+BPC 页面，并把
  本轮 Raw 作为一次 HF commit。
- `maintenance-times-process.yml`：错开 5 分钟读取最新完整 Raw commit，增量提交 Canonical，然后按
  Article/Asset → 日期 manifest → index → catalog 的顺序发布 B2 Delivery。

Process 不下载 WACZ 或整个历史 Dataset。`download_hf_snapshot.py` 只恢复最新完整 run、对应的 source
manifest/candidates，以及这些候选日期已经存在的 Canonical 分片；同日增量可以合并，下载量不会随
Raw 存档累计而线性增长。

代理订阅只从 `JOJO_TIMES_PROXY_SUBSCRIPTION` Secret 读取。任务使用固定 Mihomo 二进制生成临时配置；
首次页面抓取走延迟优选节点；网络层 401/403 或连接失败时，归档器从已通过健康检查的节点中混合
低延迟和分散位置抽样，正式任务最多切换 8 个不同节点重试。
订阅 URL、节点名、Cookie 和 Authorization 不会进入日志、manifest、WACZ 请求头或 artifact。

验证命令：

```powershell
pnpm --filter @jojo/times-pipeline typecheck
pnpm --filter @jojo/times-pipeline test
python -m pytest tools/times-pipeline/tests/test_webarchive.py tools/times-pipeline/tests/test_prepare_proxy.py -q
```

旧 Python v1 采集入口已经移除；v2 不依赖外部聚合服务、`jojo-news-archive-runner` 或 Olds API。
