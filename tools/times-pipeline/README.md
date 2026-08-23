# JOJO Times offline pipeline

Times v2 是 JOJO 看报的离线时事流水线，不提供前端请求触发的抓取 API。完整契约见
[DESIGN.md](DESIGN.md)，媒体实测记录见 [FULL_TEXT_AUDIT.md](FULL_TEXT_AUDIT.md)。

## 当前覆盖

`sources.v2.json` 启用 23 家媒体：AP、The Guardian、Bloomberg、The New York Times、Reuters、
Financial Times、Axios、NPR、Nikkei Asia、联合早报、Al Jazeera、SCMP、新华网、人民网、央视新闻、
中国新闻网、澎湃新闻、财联社、CNA、Deutsche Welle、Focus Taiwan、Africanews、Agência Brasil。

发现和正文是两套独立策略：

- RSSHub package：进程内调用锁定的 RSSHub route，不部署 RSSHub 服务。
- 官方 RSS / RSS 列表：直接抓取并保留原始 XML。
- Sitemap：目前用于 Reuters 官方 URL 发现。
- `discovery-body`：逐篇质量门槛通过后直接标为全文。
- Chromium+BPC：每轮最多 50 个新页面或到期重试页面，生成标准 WARC 1.1/CDXJ/WACZ，并把通过
  通用正文质量门槛的页面回填为全文。
- `discovery-summary`：正文不可用时保留真实摘要，绝不把 metadata-only 伪装成摘要。

同一 route 内允许全文与摘要混合。例如当前实测 NPR 3/3 为全文、联合早报 24/24 为全文，Nikkei
和 Al Jazeera 则逐篇判定。NPR route 的 gzip 兼容修复和可录制 fetch hook 都保存在锁定 RSSHub
package patch 中。

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
订阅 URL、节点名、Cookie、Authorization 和控制密钥不会进入日志、manifest、WACZ 请求头或 artifact。

验证命令：

```powershell
pnpm --filter @jojo/times-pipeline typecheck
pnpm --filter @jojo/times-pipeline test
python -m pytest tools/times-pipeline/tests/test_webarchive.py tools/times-pipeline/tests/test_prepare_proxy.py -q
```

旧 Python v1 流程暂时保留作历史结果对照；v2 不再依赖 `jojo-news-archive-runner` 或 Olds API。
