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

每个 `source.json` 还必须声明 `publicationTimeZone`（IANA 时区）。Epoch 和带 `Z/±offset` 的时间直接归一化；
不带时区的发布时间按该媒体声明的时区解释。新华网、人民网、中国新闻网和联合早报的 HTML 使用
`wall-clock` 模式，以纠正源站把本地墙上时间错误标作 UTC 的情况。发现窗口同时检查起点和终点，默认只
允许最多 120 秒的出版方时钟偏差，超出窗口的条目留在 Raw 审计计数中但不进入正文抓取。

发现默认使用官方 RSS、sitemap 或出版方轻量 API，不逐篇启动浏览器。正文阶段处理所有尚未成功抓取
的新 URL，没有全局抽样或 50 篇上限：

- direct-first：普通 HTML 能稳定给出全文的媒体先直连，正文不足再启动浏览器；
- browser-first：Bloomberg、NYT、Reuters、FT、Axios、Nikkei、联合早报和 SCMP 直接进入浏览器；
- 所有浏览器都由 Playwright 持久上下文控制，启用 JavaScript 和锁定版本 BPC；NYT 由 Playwright 直接控制锁定 Brave，其余媒体使用锁定 Playwright Chromium；
- NYT 的 BPC 请求若被 401/403/429 拒绝，会在同一节点用新的 Playwright Brave 原生 profile 重试，避免 BPC 的站点 UA 规则本身触发拦截；
- 同一媒体串行复用 Cookie，不同媒体默认最多八路并行；
- 401/403/429、JS challenge 或正文不完整不会被判成硬付费墙；需要代理的媒体在失败文章之间轮换探针，每个备用节点只探测一篇，最多验证 12 个分散的 Mihomo 节点，命中后才补抓该媒体剩余文章；
- 视频和图集在发现阶段跳过；只有完整正文进入 Canonical/Delivery，摘要只留在 Raw 审计数据。

## 本地运行

~~~powershell
pnpm install
pnpm --filter @jojo/times-pipeline exec playwright install chromium
pnpm --filter @jojo/times-pipeline build

Expand-Archive tools/times-pipeline/vendor/bpc/bypass-paywalls-chrome-clean.zip -DestinationPath $env:TEMP/bpc
$env:JOJO_TIMES_BRAVE_PATH = '<本机 Brave 可执行文件路径>'

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
raw/{source}/assets/，按字节 SHA-256 去重。流水线不生成或上传 WARC/WACZ。

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
Delivery 构建会合并旧 index，所以滚动历史不会在下一轮消失。不存在 `latest.jox`。
各新闻媒体的 Dataset index 与 catalog 条目固定写入 `aiEnabled: false`；它们可以继续在
资料库和时事页面展示，但不会进入馆藏 AI 的检索范围。

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
