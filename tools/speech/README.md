# 听读音频：B2 + blacknews CDN

## 已实现的路径

1. 前端点击“听”先检查登录状态；退出登录即停止播放。仅软限制，没有媒体鉴权。
2. 用户仅选择男声/女声，使用 `SHA256(JSON.stringify(["auto", "two-voices-v1", "male" | "female", normalizedText]))`
   查找 CDN 上的小型 JSON 描述文件；命中后 `<audio>` 直接播放 CDN MP3，无 Blob 解包、无 Jox。
3. 未命中则 `POST /api/v1/speech`。后端先查 B2，只有明确不存在才调用 TTS；B2 的 403、超时、
   损坏描述文件不会当作未生成，避免存储故障导致重复计费。成功上传后返回 JSON 音频地址。
4. Edge 输出 MP3；MiMo 输出 WAV，在函数内用 LAME 转为 48 kbps 单声道 MP3。编码运行在线程，
   不需要启动 ffmpeg。每请求最多 600 字符，同时合成最多 2 段，等待超过 2 秒返回 429。
5. 下一段提前准备和预加载；UI 保持整章进度，不把底层分段当作章节。已经知道的段使用真实时长，
   提前以最多 4 个并发读取本章已有音频的时长（最多 256 段，不触发生成）；未生成的段仍按字数估算，
   播放后校准。分段切换不承诺采样级无缝。
6. 进度仍保存在当前浏览器 localStorage，不新建 Supabase 表、KV、队列或跨设备进度服务。

## 阅读位置与按段高亮

从阅读器新开听书时，各客户端读取当前页面首个可见正文字符，略过不完整句尾，从下一句开始。
播放会保存独立的章节与位置；暂停后翻阅其他页面，再播放继续原音频。“原文”定位到听读的位置。
声音列表加载前也显示“男声/女声”，不短暂显示内部的 `male/female`。

mini 播放器通过 DOM Range 绘制高亮，不改动正文和批注索引。Web/Desktop 和手机 WebView 共用定位实现。
高亮范围是当前音频段对应的整段正文，可能包含多个自然段；切换音频段时才移动，不在段内估算句子进度。
暂停时保留高亮，翻页不会修改听读进度；收起为 mini 后继续显示，关闭听读则清除。
本次不接入逐句时间戳，不下载全库音频或执行离线对齐；继续复用现有音频缓存。
从阅读位置起播时只裁开入口段，其后各段保留原缓存键。

请求使用异步 I/O，但浏览器会等待这一小段合成、上传完成后得到地址，**不是持久化后台任务**。
函数被回收或生成失败后可重新请求；已提交到 B2 的段可跨机器、用户与函数实例复用。
同进程首次并发请求合并；没有分布式锁，多个实例同时第一次生成同一段，仍可能重复调用。
为避免这种竞争造成音频与时长不一致，MP3 路径还包含实际音频内容哈希。

### 两种逻辑音色

新客户端通过 `/api/v1/speech/providers?v=2` 请求逻辑音色目录。
未带版本参数的已安装 0.0.2 客户端继续使用两种物理音色及原有缓存键，避免旧播放器无法解析逻辑索引；
兼容目录同样只展示男声、女声。升级后自动使用 MiMo 优先、Edge 回退的新协议。

男声优先 MiMo 白桦、备用 Edge 云扬；女声优先 MiMo 冰糖、备用 Edge 晓晓。
声音列表只暴露 `auto` 下的 `male/female`，各客户端将旧声音偏好迁移为对应性别。
只有 provider 不可用或合成抛错才回退；B2 读取、上传、描述文件校验和本机队列饱和不触发回退。
逻辑索引 `segments/auto/<前2位>/<逻辑hash>.json` 包含 `sourceKey/provider/voice`，
指向原来的 `segments/mimo|edge/...mp3`，不复制已生成文件。原始 provider hash 不变。
命中逻辑索引后直接复用（包括曾经回退的音频），不在每次播放时尝试升级成 MiMo。
后台全库任务仍显式固定 `--provider mimo --voice 白桦`，不会在故障时将全库换成 Edge。
如需修改上述映射，升级 `two-voices-v1`，避免旧逻辑索引永久引用原音色。

### 当前清理与并发边界

新闻请求携带 `scope: "news"`，音频、物理描述文件、逻辑音色索引全部隔离在 `audio/speech/v1/news/`。
新闻描述文件记录生成完成后 24 小时的 `expiresAt`；客户端与后端均拒绝过期命中，过期后按需重新生成。
逻辑索引继承物理音频的过期时间，不因有人访问而续期。书籍路径、哈希、预生成缓存均保持不变。
本地新闻 SQLite 使用独立 `.news` 文件、24 小时 TTL；书籍仍为 30 天。数据库过期清理由缓存读写触发。

B2 物理清理需另行安装生命周期规则，不能将“过期不再复用”当成“已经释放存储”。
`python tools/speech/news_lifecycle.py --use-rclone` 只读审查，`--apply` 才写入。
目标仅为新闻前缀：上传 1 天后隐藏、隐藏 1 天后永久删除（B2 按周期执行，并非精确 24 小时释放空间）。
工具使用 B2 原生 API：允许继承全桶的旧版本清理，保留全部无关规则；若有上层上传过期规则则停止供人工审查。
只更新 `lifecycleRules`，使用 `ifRevisionIs` 防止并发覆盖，写后重新读取确认其他桶属性没有变化。
原生 B2 支持重叠前缀，S3 兼容接口不支持；后续生命周期统一用本工具管理，不混用 S3 生命周期写入。
这不影响音频继续通过 S3 上传、CDN 直读，也不改变公开策略、CORS、加密或复制配置。
2026-09-05 已在 `jojo-newspaper` 应用并回读验证（桶 revision 3 → 4）：现有全桶旧版本 1 天删除规则原样保留，
仅新增新闻前缀上传 1 天隐藏、隐藏 1 天删除；无关桶属性核对一致。此记录不代表应用代码已部署。
旧版新闻曾与书籍共用物理音频，无法安全识别，旧共用目录不删除。
跨云函数去重另需共享的原子任务占位/租约，不能把实例内 `_pending` 当作分布式锁。

## B2 对象布局

复用 `JOJO_DELIVERY_REMOTE` 对应的桶（当前 `jojo-newspaper`）。只新增 `audio/speech/v1/`，
不修改书籍/新闻资源、桶公开策略、CORS 或 CDN 规则；新闻生命周期运维独立且默认只读。

```text
audio/speech/v1/
  segments/<provider>/<hash前2位>/<请求hash>.json
  segments/<provider>/<hash前2位>/<请求hash>/<MP3内容hash>.mp3
  news/segments/<provider>/<hash前2位>/<请求hash>.json
  news/segments/<provider>/<hash前2位>/<请求hash>/<MP3内容hash>.mp3
  books/<dataset>/<item>/<音色hash>/<chapter>/<版本hash>.json
  books/<dataset>/<item>/<音色hash>/<chapter>/index.json
```

所有书籍共用长期音频池，新闻共用独立的短期池；书籍章节清单只引用音频，不重复保存媒体。
每份音频和描述文件对应一种固定的内容/音色/合成版本；修改语速只调整浏览器播放速率。
先上传 MP3，后上传段描述文件；整章全部成功后才发布章节清单及 index。
描述文件记录对象路径、真实时长、字节数和 SHA256，没有正文、用户 ID、API Key。
批量章节清单额外记录段顺序与时间偏移。网页目前通过相同段哈希直接命中音频池，
不依赖批量清单，因此在线生成与离线生成能互相复用。

书籍 MP3、不可变 JSON 使用一年缓存；章节 index 使用 60 秒缓存。新闻 MP3 请求 1 小时缓存、JSON 60 秒缓存，客户端另检查绝对过期时间。CDN 若有覆盖源站缓存头的规则，
以其配置为准。CDN 的 404 负缓存不会触发重复合成：后端仍会查 B2。
**不要给整个桶设置生命周期删除规则**；后续清理需要在音频前缀内做引用检查。

## 本地运行

```powershell
python -m pip install -r backend/requirements-dev.txt
python tools/dev-backend.py --b2
```

`--b2` 在内存读取本机已有 rclone 的 `JOJO_DELIVERY_REMOTE` S3 配置，和主 checkout 的 `.env`。
不复制或打印密钥。已有环境变量优先，其次 worktree `.env.local`/`.env`，然后主 checkout。
不带 `--b2` 且未设置 `JOJO_SPEECH_STORAGE` 的开发环境仍使用原 SQLite 缓存，以便无 B2 时开发。

## 手工预生成书籍

全库（只读取已发布的 book / book-series，不含草稿）先生成清单，再执行单音色批处理：

```powershell
pnpm --filter @jojo/content-pipeline speech-plan --cdn https://blacknews.jojokanbao.cn --all-books --output <绝对路径/library-plan.json>
python tools/speech/generate.py --plan <绝对路径/library-plan.json> --provider mimo --voice 白桦 --all --concurrency 2 --use-rclone --report .runtime/speech/library-report.json
```

这会产生 B2 写入和提供方调用；必须人工明确授权。中断后重复同一命令会复用已提交的段。

## 前端灰度与客户端

`reader.speech` 是 Web、Desktop、Android、iOS 和墨水屏 Android 共用的前端 flag，默认关闭。
迁移 `202609050001_reader_speech_flag.sql` 只创建关闭规则；通过现有 feature flag 管理界面按用户灰度开启。
缺少配置、评估失败均不开放听读。登录退出/flag 关闭后停止播放。
它与 `JOJO_TTS_ENABLED` 不同：后者只控制后端能否生成新音频，不影响 CDN 已有音频。

Desktop 复用网页播放器，通过固定白名单的 `jojo-agent://reader/api/v1/speech*` 访问 API。
Mobile 使用 expo-audio 播放相同 CDN MP3，支持系统媒体控件、跨段进度、续听和定时关闭。
API 默认 `https://beta.jojokanbao.cn`（可用 `EXPO_PUBLIC_READER_API_BASE` 配置公开入口，不能填密钥）。
进度保存在本机 AsyncStorage，按用户/书籍隔离；不做跨设备同步。
手机 0.0.2 新增原生音频模块，因此必须发布新安装包，不能向 0.0.1 下发仅 JS 的热更新。
墨水屏版复用功能，但不使用背景模糊或动画。AI、笔记、选区和阅读工具打开时隐藏听读入口与 mini 播放器。

优先从已经生成的 Canonical 目录生成计划（不会请求 TTS 或上传）：

```powershell
pnpm --filter @jojo/content-pipeline speech-plan --canonical "D:/books-build/canonical/books" --output ".runtime/speech/plan.json"
```

输出路径相对该命令工作目录 `tools/content-pipeline`；实际操作建议传**绝对路径**。
也支持从已发布的 CDN 内容读取一本书，不需要重新导入源文件：

```powershell
pnpm --filter @jojo/content-pipeline speech-plan --cdn https://blacknews.jojokanbao.cn --dataset <dataset-id> --output <绝对路径/plan.json>
```

默认只生成计划中的第一章，默认音色白桦，不自动全量：

```powershell
python tools/speech/generate.py --plan <plan.json> --use-rclone --dry-run
python tools/speech/generate.py --plan <plan.json> --use-rclone --report .runtime/speech/sample-report.json
# 指定样本章节
python tools/speech/generate.py --plan <plan.json> --use-rclone --chapter <chapter-id>
# 确认样本后，手动全量跑一个声音
python tools/speech/generate.py --plan <plan.json> --use-rclone --all --concurrency 2 --report .runtime/speech/full-report.json
```

工具使用与网页相同的分段器；手动工具 `--concurrency` 接受 `1` 到 `16`，默认 `1` 保持串行。
只预取所选并发数量的段，不一次提交整本/全库；按原文顺序记录 offset，整章成功后才发布清单。
离线并发通过 ContextVar 隔离，退出离线上下文即恢复；线上函数仍固定最多 2 段。
遇到终止错误不再派发后续段，也不取消已经发出的合成：等待在途任务完成 B2 保存后停止。
失败段之后已保存的预取音频可能尚未进入本次有序报告，但重跑仍会从 B2 命中，不需重新合成。

单书工具默认实际合成请求（含重试）最多 30 次/滚动分钟，缓存命中不占该预算。
MiMo 仅对明确的 HTTP 429 最多重试两次，退避 5/10 秒；有效 `Retry-After` 更长时遵从它，
若要求等待超过 60 秒则停止，不提前重试。读超时、其他 HTTP 错误和 B2 错误均不自动重试。
该限制仅覆盖当前离线进程，不是账号全局限流；不要同时启动多个全库进程。
本地 MiMo 批处理不设 HTTP 响应体和解码 WAV 的字节数上限；线上仍默认限制响应 16 MiB、原始音频 12 MiB。
这个豁免仅由离线适配器设置，不暴露到请求参数或全局环境变量；上下文退出后恢复线上适配器。
仍保留原来的每段 600 字符、音频格式/有效性及单段 600 秒校验、超时和请求限速，不代表无限制并发或内存占用为零。
按书调用 `generate()` 的包装器应在同一事件循环复用一个 `RequestLimiter`，通过 `limiter=` 传入，
避免每本书重置速率预算。线上 API 的两段保护槽、缓存版本和请求协议不变。

### 两种声音的全库续跑

全库入口现在使用独立离线流水线，不再等待 B2 上传才释放合成名额：缓存查验 → 合成/编码 → 本地持久化 → 独立上传 → 发布章节。
`outbox.sqlite3` 位于输出目录，使用 SQLite WAL/FULL 事务保存待上传 MP3 BLOB、时长和校验值；不存正文或 API Key，不影响线上 API。
上传默认 32 并发，可用 `--upload-workers 64` 提高到 64；最高支持 96，并与合成并发独立控制。连接/5xx 等错误退避重试上传，鉴权失败慢速重试并记录错误，不计入 MiMo 账号失败、不直接停止合成。
上传后回读段描述文件确认提交，才清空对应本地音频 BLOB；持久化小型回执保留用于重启去重。崩溃发生在远端提交之后时，重跑先查 B2，不重复 PUT 或 TTS。
待上传上限默认 20 GiB，磁盘保留 5 GiB，并为在途任务预留空间；达到容量保护时暂停新合成，上传释放空间后自动继续。SQLite 自动回收已确认音频占用的页。
本地磁盘损坏、写入失败或待上传数据校验失败仍停止并报告，绝不静默丢弃或重合成。不要删除 outbox.sqlite3 或其 WAL/SHM 文件。
首次缓存查验仍须确认 B2 缺失：若读取也故障，查验阶段重试，不把故障误当缓存未命中；已确认缺失的任务与已落盘的音频独立继续。
章节仅在全部音频确认上传后发布；清单发布单独退避，不再因 B2 发布故障停止合成。STOP 会保存已在途合成、保留待上传队列后退出，不强行等 B2 恢复。
状态区分 `staged`/`stagedPerMinute5m`（本轮新合成落盘）、`generated`/`generatedPerMinute5m`（本轮确认上传）、`outbox.pending/pendingBytes`（跨重启待上传）及 `storage`（各存储阶段重试）。旧吞吐记录是耦合流水线的上传完成速率，不是纯合成极限。

#### 可选：B2 多节点上传（仅本地批处理）

`b2_proxy.py prepare` 从用户已导入的 Clash 订阅 YAML 提取节点，为每个不同节点地址创建独立的 `127.0.0.1` HTTP CONNECT 监听端口。
只生成独立 Mihomo 实例的配置，不修改 Clash Verge、系统代理、TUN、MiMo 客户端或线上 API。
节点密码只存在 Git 忽略的运行目录中；不要提交、展示或复制这些配置到日志。不要将订阅链接或任何 API Key 放在命令行。
需要本机已有 Mihomo 核心和 PyYAML，核心始终用独立运行目录启动，Windows 后台启动须隐藏窗口。

```powershell
python tools/speech/b2_proxy.py prepare --profile <已导入的订阅文件> --output .runtime/speech/b2-proxy --core <本机Mihomo程序>
# 先用独立 -d/-f 配置启动核心，不启用 TUN；再探测公共服务根地址，不访问桶或下载音频。
python tools/speech/b2_proxy.py probe --directory .runtime/speech/b2-proxy --endpoint https://s3.us-west-004.backblazeb2.com --take 8
python tools/speech/library.py --plan .runtime/speech/library-plan.json --output .runtime/speech/library-two-voices --rpm 80 --accounts 10 --start-concurrency 64 --max-concurrency 64 --upload-workers 64 --use-rclone --b2-routes .runtime/speech/b2-proxy/routes.json
```

`--b2-routes` 为每条线路建立独立 boto3 客户端，只允许显式回环代理；B2 仍使用 HTTPS 并校验服务器证书，不设置全局代理环境变量。
上传工人共享经测试的节点，每个节点最多 16 个并行存储操作；缓存查验、音频上传及清单发布均选当前最空闲的健康线路。
一次上传尝试的查询、PUT 和描述文件校验保持在同一线路；失败节点冷却 4–60 秒，下次尝试可换线路，使用同一份已落盘 MP3，不重复合成。
所有线路不可用时原有退避和磁盘容量保护继续生效，不自动切换 MiMo 出口或创建新的合成任务。
`summary.json.b2Routes` 记录各节点活动数、成功/失败次数、确认上传数、字节数和冷却时间，不包含真实节点地址或凭据。
HEAD 延迟只能筛选连通性，不能代表大文件上传吞吐；上线后以实际确认上传和积压变化为准。多节点也不能突破本机网络总上行带宽。
重启时须先确认独立核心与相应回环端口可用；保留原 outbox、checkpoint 及并发控制文件，同一时刻只启动一个全库进程。
重启先将持久化待上传音频入上传队列，不等历史章节的 B2 缓存扫描抵达对应段；其他任务继续查缓存，不重复调 TTS。
`concurrency.json` 可同时写 `{"perAccount":64,"uploadWorkers":64}`：十账号合计 640 合成并发、64 上传并发。
只修改上传数不会重置 MiMo 的 429 退避；降低任一并发均不取消在途任务。章节 JSON 发布使用独立线程池，避免上传占满清单发布名额。
章节清单默认 16 并发，可用 `--publish-workers 64` 提高；每章先成功上传不可变清单，再更新索引，最后串行原子提交本地断点，避免并发丢记录。
音频均已确认上传后，可加 `--publish-only` 续跑：仅复用本地回执和 B2 描述文件，禁止调用 MiMo；发现缺失音频或待上传 MP3 就停止，不暗中重新合成。
`summary.json` 的 `publishWorkers`、`activePublications`、`publicationQueue` 和 `chaptersPerMinute5m` 单独展示清单发布进度。
此参数是启动参数，不由 `uploadWorkers` 热调节。修改旧串行发布实现后需要一次安全断点续跑；正常运行不得反复重启。
2026-09-06 用户要求进一步提速，已授权由旧 240 档提高至 640；旧耦合流水线的并发对照表仅保留为历史记录，不应自动将新多节点流水线降回 240。
随后实测上传 96 出现持续超时、成功上传反而下降，目前实际控制为 `{"perAccount":64,"uploadWorkers":48}`，不能因积压增长就恢复 96。
独立代理可用 `b2_proxy.py remap` 为已测试的其他订阅节点生成替换配置，保持批处理使用的回环端口不变；验证配置并核对进程身份后只替换任务专用核心，不改主 Clash Verge，不重启或取消合成。替换期间的上传错误仍用同一份落盘音频重试。
RPM/Token 预算仍不变，需按新运行窗口对比成功合成、上传速度及错误率；并发数不是实际每分钟请求数。

```powershell
python tools/speech/library.py --plan .runtime/speech/library-plan.json --output .runtime/speech/library-two-voices --rpm 80 --start-concurrency 32 --max-concurrency 32 --use-rclone
```

固定白桦/冰糖，入口使用 `library_pool.py` 跨章节池，每个账号独立 RPM/Token 预留预算，不生成 Edge 备用音色。
整个计划按音色和规范化文本去重，所有章节共享有界工作池，先完成的段立即补位，不等最早的慢段或章节收尾。
每个对象的结果分发到引用它的所有章节；整章齐了由单独发布队列按原文顺序计算 offset、发布清单和断点。
默认直接从每账号 32 并发启动。只有明确的 429 限流反馈才减半；普通段失败不降低并发，也不清空恢复样本。
限流后每累计 32 个成功生成且没有新限流反馈的样本增加 8，直到恢复所设上限。原有鉴权/连续失败停机保护仍保留。
不宣称已找到提供商的最大吞吐，线上 API 仍保持 2 并发。
RPM 配置最多 80，当前任务用 80；Token 以请求 UTF-8 字节数加 8192 输出额度进行保守预留（非实际账单用量），
上限 8M/分钟，同一账号其他客户端用量仍需预留空间。限流预算不跨进程，所以同一时间只运行一个全库任务。
本机回环端口锁防止此工具重复启动，不影响旧版工具，启动前仍应确认旧版进程已停止。

`checkpoint.json` 保存已完成的章节/音色及计划哈希，`summary.json` 保存心跳、请求数、限流次数和最近性能样本。
每章单独报告；失败段继续下一项，最后再尝试一轮，成功对象始终先查 B2。权限错误或连续五段失败会停止。
Windows 报告文件短暂被读取/索引锁住时仅重试本地原子替换，最多约 3 秒，不重新请求 TTS；持久写入故障仍会停止。
仍有失败章节时状态为 `partial`，不能当成完成。报告的 referencedBytes 为章节引用之和，跨章节去重前，不是桶账单。
在输出目录创建 `STOP` 文件会停止派发新请求、等待在途音频保存并发布已完整章节；删除 STOP 后用相同命令断点恢复，不删除音频。
旧版逐章工具的 checkpoint 可直接复用；尚未完整的章节按 B2 对象重新查缓存，已上传音频无需重新合成。
当前库 89620 段/声音，规范化文本去重后 83916 段/声音，两个声音约 167832 个独立请求。
扣除已有缓存前，即使 100 RPM 持续满载也约 28 小时；按 80 RPM 理论约 35 小时，不能保证 24 小时内完成。
以上为单账号预算。确认属于两个独立账号后可加 `--accounts 2`，从本机环境读取
`MIMO_API_KEY` 和 `MIMO_API_KEY_2`（仅用于离线工具，不通过命令行传密钥；线上统一使用 `MIMO_API_KEYS` 数组）。
RPM、Token 预留和启动/最大并发均按账号独立计算：两个账号各 80 RPM、32 并发，合计最多 160 RPM、64 并发。
每个账号独立限流退避；所有工人共享一个去重队列和 B2 缓存，账号不参与音频哈希。
不能将同账号的两把 Key 当成双倍配额；不要另外启动任务消费这两份预算。
双账号按 160 RPM 满载的请求数理论下限约 17.5 小时，实际受合成延迟、网络和上传速度影响，仍不保证一天完成。
状态文件只记录 account 1/2 的请求数、生成数和并发，不记录 Key。
第三个独立普通 API 账号使用主 checkout 的 `MIMO_API_KEY_3`，显式加 `--accounts 3` 启用。
三个账号各 32 并发、80 RPM、8M Token 预留/分钟，合计最多 96 并发、240 RPM；仍共用去重队列与缓存。
Key 必须存在且互不重复；未指定三个账号时不会使用第三把 Key。Token Plan 配置不会被自动读取或加入批处理。
更多独立账号使用连续编号 `MIMO_API_KEY_4` 等，通过 `--accounts N` 显式启用，工具支持 1–10 个账号。
七账号提速试运行使用 `--accounts 7 --start-concurrency 64 --max-concurrency 64 --rpm 80`，
上限合计 448 并发、560 RPM；各账号 8M Token 预留/分钟。CLI 默认仍为每账号 32 并发，支持显式选择 48/64。
224 并发的稳定窗口实测约 335 请求/分钟，增加并发用于覆盖单段处理等待，不提高 RPM/Token 预算，也不保证达到预算上限。
状态文件额外记录每账号滚动分钟请求数、最近 100 个成功新生成段的平均处理秒数；后者包含缓存检查、限速等待、合成、编码和上传，不是单独的提供商延迟。
发现新 Key 不会自动增加账号数量。
2026-09-06 七账号 448 并发曾连续两轮连接超时停机，没有 429；单个启动窗口达到 560 RPM 不等于稳定吞吐。
新增三个已确认独立的普通账号后，当前续跑命令为 `--accounts 10 --start-concurrency 64 --max-concurrency 64 --rpm 80`，最多 640 并发、800 RPM。
跨章节工具现在每账号均匀发送（80 RPM 时最短间隔 0.75 秒），并保留滚动 RPM/Token 与 429 冷却预算；空闲或冷却不积累突发额度。
离线连接池保留最多 64 个空闲连接、60 秒保活，以减少重复 TLS 建连；线上行为不变。连接稳定性仍需实测，不能保证解决所有网络超时。
离线跨章节池将 B2 读写和编码放入独立有界线程池（当前十账号 80 个线程），不占用 asyncio 的默认 DNS 线程池。
`summary.json` 的 `blockingPool.stages` 记录各阶段执行/排队时间和活动数量；`meanSynthesisSeconds` 包含请求预算等待和完整音频接收，只统计成功样本。
运维可在输出目录写入 `concurrency.json`，内容为 `{"perAccount":32}`，将实际并发调整为每账号 32，最多不超过启动命令的 `--max-concurrency`。
调低只停止补位，不取消在途音频；调节文件值不变时不会反复重置 429 退避。无效文件保留原档位并在状态中记录错误。
总 RPM/Token 预算不会随此文件改变。最大并发与实际当前档位不同，恢复时应同时核对调节文件，不能只看进程命令行。
旧耦合流水线历史对照（2026-09-06，同一续跑队列、避开换档过渡）：640 并发约 292 段/分钟，320 约 365，480 约 364，240 约 496，160 约 312。
这些是不同正文样本的短窗口观测，不是提供方 SLA 或全局最优证明。此前用 `perAccount:24`；拆分上传并接入多节点后，用户已要求提高到 `perAccount:64, uploadWorkers:64`，按新窗口的实际速度和错误率验证。
恢复命令保留 `--max-concurrency 64 --upload-workers 64`，不要删除控制文件或按历史记录降回 240；线上限制仍不变。
增加账号前验证凭据，切换时等待旧任务退出和滚动分钟预算冷却；观察可用内存、实际完成速度与上传错误。
操作前确认文件内容属于已授权的公开书库；工具不会部署、改桶规则或自动生成其他声音。

重跑会检查 B2，跳过已成功段；同一在途生成的 `shared` 结果计为缓存复用。
本地 plan 含正文，请留在被 Git 忽略的 `.runtime/`；report 不含正文/凭据，每段成功后原子保存。
报告包含独立音频总字节数、本次新生成字节数、总时长、缓存命中数及失败章节。
章节清单、描述文件和 B2 版本存储的开销不计入 `uniqueBytes`，所以它不是桶账单总量。

48 kbps 的名义音频量约 21.6 MB/小时（十进制，不含少量编码头）。先实际跑白桦，再用完整报告
决定是否生成其他声音；不同音色大小相近只是估算，不直接等同于全库已经完成。

## 云端配置

Web 部署先在 Linux/Python 3.10 构建 EdgeOne 的完整 `.edgeone` 产物，再做隔离运行验证。
CLI 1.6.14 会把依赖内名为 `docs` 的目录一并删掉，但 `boto3.docs`、`botocore.docs` 是运行模块；
`repair-python-bundle.py` 只从产物中同版本的官方 wheel 恢复这两个目录，不升级依赖。
`verify-python-bundle.py` 检查实际入口、API、S3 客户端模型和 MP3 编码；失败则不发布。
上传预构建的 `.edgeone`，避免服务端重新打包、再次误删。PR 也运行这套构建验收，但不部署。

云函数不依赖 rclone、SQLite 持久化盘或 Supabase。需通过部署平台的私密环境变量配置：

```dotenv
JOJO_SPEECH_STORAGE=b2
JOJO_SPEECH_S3_ENDPOINT=https://s3.<region>.backblazeb2.com
JOJO_SPEECH_S3_REGION=<region>
JOJO_SPEECH_S3_BUCKET=jojo-newspaper
JOJO_SPEECH_S3_KEY_ID=<已有B2 key id>
JOJO_SPEECH_S3_APPLICATION_KEY=<已有B2 application key>
JOJO_SPEECH_CDN_BASE=https://blacknews.jojokanbao.cn
JOJO_TTS_ENABLED=true
MIMO_API_KEYS=["<key-1>","<key-2>"]
```

`MIMO_API_KEYS` 是后端私密环境变量，值为 JSON 字符串数组；新增或删除 Key 只修改这个数组。
空白 Key、非字符串及非法 JSON 会拒绝启动，重复 Key 会去重。数组存在时优先使用数组，
`[]` 明确表示不使用 MiMo；仅未配置数组时兼容旧的 `MIMO_API_KEY`。
不读取 `_2`、`_3` 等编号环境变量，也不自动接入 Token Plan。

线上按在途请求数选择空闲 Key，同等负载轮换，冷启动随机起点，避免实例全部从第一把开始。
429 按 `Retry-After` 冷却（未提供或无效时 60 秒），401/403 冷却 5 分钟，5xx 冷却 10 秒；
明确拒绝后可尝试另一把，每次请求最多尝试 3 把，不等待整段冷却。
网络超时或无效音频不跨 Key 重复合成；所有可用 Key 都不可用时返回现有错误协议。
调度和冷却仅在单个云函数进程内生效，不是跨实例/跨本地批处理的全局 RPM/TPM 限流。
同一账号的多个 Key 仍共用 MiMo 配额；正在运行的离线批处理预算不被线上配置重置。
Key 不进入缓存哈希、音频地址、前端或日志，已有缓存无需重新生成。
离线工具保留其原来的固定 Key 和独立预算，线上仍只有 2 个合成保护槽。

部署配置将 Python 超时设为 120 秒，API 等待上限 110 秒。MiMo HTTP 读取体积上限 16 MiB，
交付编码音频上限 12 MiB，不等于进程峰值内存（JSON/Base64/编码仍有多份缓冲）。
`JOJO_TTS_ENABLED` 是唯一的新音频合成总开关，统一作用于 Edge/MiMo 和手工预生成工具。
设为 `false` 时只复用已有缓存，不调用 TTS；设为 `true` 时允许生成缺失音频，MiMo 另需配置 Key。
开发默认开启、生产默认关闭。配置在进程启动时读取，修改后需重启后端或重新部署。
已存音频可继续从 CDN 使用，开关不改变音频地址或缓存哈希。
不加后端登录/音频鉴权是产品选择：公开地址及合成接口都可能被绕过 UI 直接使用，
2 段并发上限是单进程保护，不是账户总预算或防盗刷保障。

## 首个真实样本（2026-09-05）

《1844年经济学哲学手稿》“编辑说明”，白桦音色，4 段：251.424 秒，MP3 合计
1,508,544 字节（约 1.51 MB）。独立重跑全部 4 段命中 B2，新增 0 字节、合成调用 0 次。
CDN 实测 MP3 返回 `audio/mpeg`，Range 返回 `206`，CORS 为 `*`。当前 CDN 覆盖源站
缓存头为 `max-age=864000`（10 天），尚未修改该现有规则。这是样本记录，不代表全库体积或当前生成进度。

本工具不会部署 EdgeOne，也不会将尚未上线的 Times 添加到公开部署。
