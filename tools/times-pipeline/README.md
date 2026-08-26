# JOJO Times offline pipeline

JOJO Times 是每十分钟运行的离线新闻流水线。出版方访问发生在 GitHub Actions；Web、Mobile、Agent
只读取 B2 CDN，不通过用户请求触发抓取。完整存储契约见 [DESIGN.md](DESIGN.md)。

## 覆盖范围

sources.v2.json 启用 22 家媒体和 153 个已选栏目：AP、The Guardian、Bloomberg、The New York
Times、Reuters、Financial Times、Axios、NPR、Nikkei Asia、联合早报、Al Jazeera、SCMP、新华网、
人民网、中国新闻网、澎湃新闻、财联社、CNA、Deutsche Welle、Focus Taiwan、Africanews、Agência
Brasil。央视新闻、财新、WSJ、第一财经、Indian Express 和证券时报不在生产目录。

每家媒体位于 src/sources/{source}/：

- source.json：栏目、发现入口、正文门槛、页面抓取策略；
- discover.ts：仅在出版方需要自有 API/栏目协议时存在；
- fetch.ts：正文容器、browser-first/direct-first 和页面特例；
- process.ts：仅在 Canonical 前需要来源修正时存在；
- index.ts：来源模块装配。

发现默认使用官方 RSS、sitemap 或出版方轻量 API，不逐篇启动浏览器。正文阶段处理所有尚未成功抓取
的新 URL，没有全局抽样或 50 篇上限：

- direct-first：普通 HTML 能稳定给出全文的媒体先直连，正文不足再启动浏览器；
- browser-first：Bloomberg、NYT、Reuters、FT、Axios、Nikkei、联合早报和 SCMP 直接进入 Chromium；
- Chromium 使用 Playwright 持久上下文，启用 JavaScript 和锁定版本 BPC；
- 同一媒体串行复用 Cookie，不同媒体默认最多八路并行；
- 401/403/429、JS challenge 或正文不完整不会被判成硬付费墙；browser-first 媒体失败后最多切换三个 Mihomo 备用节点；
- 视频和图集在发现阶段跳过；只有完整正文进入 Canonical/Delivery，摘要只留在 Raw 审计数据。

## 本地运行

~~~powershell
pnpm install
pnpm --filter @jojo/times-pipeline exec playwright install chromium
pnpm --filter @jojo/times-pipeline build

Expand-Archive tools/times-pipeline/vendor/bpc/bypass-paywalls-chrome-clean.zip -DestinationPath $env:TEMP/bpc

node tools/times-pipeline/dist/src/capture-cli.js --config tools/times-pipeline/sources.v2.json --output $env:TEMP/jojo-times --since-hours 24 --workers 8
node tools/times-pipeline/dist/src/page-capture-cli.js --config tools/times-pipeline/sources.v2.json --output $env:TEMP/jojo-times --run-manifest '<runManifest>' --source-workers 8 --browser-extension-path $env:TEMP/bpc/bypass-paywalls-chrome-clean-master
node tools/times-pipeline/dist/src/process-cli.js --config tools/times-pipeline/sources.v2.json --output $env:TEMP/jojo-times --run-manifest '<runManifest>' --raw-revision local
node tools/times-pipeline/dist/src/delivery-cli.js --config tools/times-pipeline/sources.v2.json --output $env:TEMP/jojo-times --process-result '<process-result.json>' --delivery-output $env:TEMP/jojo-times-delivery
~~~

## 存储

Raw 和 Canonical 共用一个私有 HF Dataset：

~~~text
raw/{source}/
├─ state.json.gz
├─ assets/{sha256}.{ext}
└─ runs/YYYY/MM/DD/{RUN_ID}/
   ├─ manifest.json
   ├─ discovery.json.gz
   ├─ candidates.jsonl.gz
   ├─ network/...
   └─ pages/{article-key}/
      ├─ metadata.json
      ├─ original.html.gz
      └─ rendered.html.gz

raw/runs/YYYY/MM/DD/{RUN_ID}.json

canonical/{source}/
├─ dataset.json
├─ articles/{content-hash}.json.gz
└─ dates/YYYY/MM/YYYY-MM-DD.json.gz

canonical/runs/{RUN_ID}.json
~~~

original.html.gz 是主文档响应，rendered.html.gz 是 BPC/JavaScript 执行后的 DOM。正文图片下载到
raw/{source}/assets/，按字节 SHA-256 去重；Raw 不再生成或保存 WARC/WACZ。

B2 只保存 Delivery：

~~~text
catalog.jox
content/newspapers/{source}/
├─ index.jox
├─ articles/{content-hash}.jox
├─ assets/{content-hash}.jox
└─ dates/YYYY/MM/YYYY-MM-DD.jox

content/timeline/
├─ index.jox
└─ dates/YYYY/MM/YYYY-MM-DD.jox
~~~

content/timeline 是跨媒体排序索引，不是虚拟媒体。不存在 content/newspapers/times 或 latest.jox。
文章和图片内容寻址并长期 immutable；当天日期对象和 index 使用 60 秒重新验证。

## GitHub Actions

- maintenance-times-capture.yml：每十分钟完成发现、URL 去重、页面/图片抓取并原子提交 HF Raw；
- maintenance-times-process.yml：定时 Capture 成功后立即读取最新完整 Raw，提交 HF Canonical，随后按
  Asset/Article → 媒体日期 → 媒体 index → 时间线日期 → 时间线 index → catalog 发布 B2。

手动运行默认 publish=false，只产生短期 artifact。代理订阅只从 Secret 读取；订阅 URL、节点名、
Cookie、Authorization 和 BPC 内部状态不会进入 Raw、日志或 artifact。

验证：

~~~powershell
pnpm --filter @jojo/times-pipeline typecheck
pnpm --filter @jojo/times-pipeline test
pnpm --filter @jojo/times-pipeline build
~~~
