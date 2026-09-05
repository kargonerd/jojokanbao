# 听读音频：B2 + blacknews CDN

## 已实现的路径

1. 前端点击“听”先检查登录状态；退出登录即停止播放。仅软限制，没有媒体鉴权。
2. 使用 `SHA256(JSON.stringify([provider, synthesisVersion + encodingVersion, voice, normalizedText]))`
   查找 CDN 上的小型 JSON 描述文件；命中后 `<audio>` 直接播放 CDN MP3，无 Blob 解包、无 Jox。
3. 未命中则 `POST /api/v1/speech`。后端先查 B2，只有明确不存在才调用 TTS；B2 的 403、超时、
   损坏描述文件不会当作未生成，避免存储故障导致重复计费。成功上传后返回 JSON 音频地址。
4. Edge 输出 MP3；MiMo 输出 WAV，在函数内用 LAME 转为 48 kbps 单声道 MP3。编码运行在线程，
   不需要启动 ffmpeg。每请求最多 600 字符，同时合成最多 2 段，等待超过 2 秒返回 429。
5. 下一段提前准备和预加载；UI 保持整章进度，不把底层分段当作章节。已经知道的段使用真实时长，
   提前以最多 4 个并发读取本章已有音频的时长（最多 256 段，不触发生成）；未生成的段仍按字数估算，
   播放后校准。分段切换不承诺采样级无缝。
6. 进度仍保存在当前浏览器 localStorage，不新建 Supabase 表、KV、队列或跨设备进度服务。

请求使用异步 I/O，但浏览器会等待这一小段合成、上传完成后得到地址，**不是持久化后台任务**。
函数被回收或生成失败后可重新请求；已提交到 B2 的段可跨机器、用户与函数实例复用。
同进程首次并发请求合并；没有分布式锁，多个实例同时第一次生成同一段，仍可能重复调用。
为避免这种竞争造成音频与时长不一致，MP3 路径还包含实际音频内容哈希。

## B2 对象布局

复用 `JOJO_DELIVERY_REMOTE` 对应的桶（当前 `jojo-newspaper`）。只新增 `audio/speech/v1/`，
不修改书籍/新闻资源、桶公开策略、CORS 或 CDN 规则，不执行删除或同步清理。

```text
audio/speech/v1/
  segments/<provider>/<hash前2位>/<请求hash>.json
  segments/<provider>/<hash前2位>/<请求hash>/<MP3内容hash>.mp3
  books/<dataset>/<item>/<音色hash>/<chapter>/<版本hash>.json
  books/<dataset>/<item>/<音色hash>/<chapter>/index.json
```

所有书籍和新闻共用内容寻址的音频池，书籍章节清单只引用它，不重复保存媒体。
每份音频和描述文件对应一种固定的内容/音色/合成版本；修改语速只调整浏览器播放速率。
先上传 MP3，后上传段描述文件；整章全部成功后才发布章节清单及 index。
描述文件记录对象路径、真实时长、字节数和 SHA256，没有正文、用户 ID、API Key。
批量章节清单额外记录段顺序与时间偏移。网页目前通过相同段哈希直接命中音频池，
不依赖批量清单，因此在线生成与离线生成能互相复用。

MP3、不可变 JSON 使用一年缓存；章节 index 使用 60 秒缓存。CDN 若有覆盖源站缓存头的规则，
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
python tools/speech/generate.py --plan <plan.json> --use-rclone --all --report .runtime/speech/full-report.json
```

工具使用与网页相同的分段器，串行合成，失败即记录并停止；重跑会检查 B2，跳过已成功段。
本地 plan 含正文，请留在被 Git 忽略的 `.runtime/`；report 不含正文/凭据，每段成功后原子保存。
报告包含独立音频总字节数、本次新生成字节数、总时长、缓存命中数及失败章节。
章节清单、描述文件和 B2 版本存储的开销不计入 `uniqueBytes`，所以它不是桶账单总量。

48 kbps 的名义音频量约 21.6 MB/小时（十进制，不含少量编码头）。先实际跑白桦，再用完整报告
决定是否生成其他声音；不同音色大小相近只是估算，不直接等同于全库已经完成。

## 云端配置

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
MIMO_API_KEY=<secret>
```

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
缓存头为 `max-age=864000`（10 天），尚未修改该现有规则。没有开始全库合成。

本工具不会部署 EdgeOne，也不会将尚未上线的 Times 添加到公开部署。
