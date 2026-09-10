# Backend

JOJO 的统一 Python 后端。源码采用标准 `src` 布局，不依赖任何云平台的部署目录。

```text
src/app/
  main.py       本地 FastAPI 入口
  application.py  共享 API 工厂（不单独注册云函数路由）
  core/         配置、认证、错误和 HTTP 中间件
  account/      已启用的账号 API
tests/
```

## 本地运行

```bash
python -m pip install -r backend/requirements-dev.txt
pnpm dev:backend
```

接口：

- `GET http://127.0.0.1:8088/v1/health`
- `GET http://127.0.0.1:8088/v1/me`
- `POST http://127.0.0.1:8088/v1/speech`（开发环境默认开启）

## 听书 / 听新闻

听读交付采用 **B2 + 现有 blacknews CDN**，不包装 Jox，不使用 Supabase 存音频或进度。
`GET /v1/speech/providers` 返回音色、合成版本和公开 CDN 基址，不包含凭据。
`POST /v1/speech` 接受 `{text, provider, voice}`（每段最多 600 字符）：
B2 模式先查共享缓存，未命中才合成、压缩、上传，返回包含 `url/object/duration/bytes` 的 JSON。
前端先直接查 CDN 描述文件；已预生成的音频无需再调用合成 API。

支持流式播放的新客户端读取 v2 声音列表中的 `streaming` 能力，在前台从零起播时使用
`POST /v1/speech?stream=true`。服务端返回 15 分钟有效的加密播放票据，播放器直接读取
`GET /v1/speech/stream?ticket=…`：缓存命中跳转到已有 CDN MP3；缺缓存时调用 MiMo
`stream: true / pcm16`，将 24 kHz 单声道 PCM16LE 增量转成 48 kbps MP3，边生成边交付。
完成后沿用原有对象、描述文件和逻辑声音别名，因此整库预生成音频仍可复用。
票据使用现有 B2 服务端凭据派生专用密钥，不在 URL 中暴露书籍正文，也不依赖单个实例的会话状态。
旧客户端、离线工具、后台预取以及需要定位到非零时间的请求继续使用完整音频接口。
前台 CDN 元数据查询最多等待 1.5 秒，随后由服务端查询权威缓存；后台时长查询仍为 6 秒。
每次生成最长 105 秒，与原有生成请求共用并发限制和同进程去重；播放连接关闭后，有界生成可继续完成缓存，
但这不是持久后台任务，实例退出时不保证完成。中途失败不发布缓存，也不在已发出的声音中拼入备用音色。

- 登录仅在前端限制，后端和音频 URL 不鉴权，这是明确的产品选择。
- MiMo Key、B2 凭据只在服务端。`JOJO_TTS_ENABLED` 统一控制 Edge/MiMo 新音频合成；关闭不影响缓存播放。MiMo 新合成还需 `MIMO_API_KEY`。
- 总开关开发环境默认开启、生产默认关闭；修改环境变量后需重启后端或重新部署，不是前端用户设置。
- MiMo WAV 转 48 kbps 单声道 MP3；Edge MP3 直接存储。每进程最多同时合成 2 段。
- 合成、编码、上传均有界；使用异步请求，但不是持久化后台任务队列。
- B2 命中可跨用户/实例复用；同进程首请求合并，跨实例同时首次仍可能重复合成。
- MP3 文件按音频内容哈希不可变存储，描述文件最后上传，避免并发覆盖导致音频与时长错配。
- 本地无 B2 时可保留 SQLite 开发缓存；B2 模式不写本地音频。
- 播放进度只存当前浏览器，清理站点数据后消失，不提供跨设备同步。

本地启动：`python tools/dev-backend.py --b2`，从已有 rclone delivery remote 读取凭据到内存。
不带 `--b2` 时使用显式环境配置，开发环境缺省为本地模式。
EdgeOne Python 超时已调整为 120 秒以容纳合成与上传；代码修改不会自动部署到云端。

完整对象布局、私密环境变量、故障语义和白桦样本/全库生成命令见
[听读运维说明](../tools/speech/README.md)。
MiMo 免费期以[官方定价](https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go)为准，不假设永久免费。

Times 已迁移到 `tools/times-pipeline/` 的离线 GitHub Actions 流水线。Web 从 B2 CDN
读取 Jox，不再通过 Python API 请求时实时抓取新闻。

## 测试

```bash
pnpm test:backend
```

## 部署

EdgeOne 薄入口位于 `infrastructure/edgeone/functions/api/index.py`，显式执行
`app = create_app()`；平台根据顶层赋值识别框架入口，单纯导入 `app` 不会注册路由。
平台剥离 `/api` 前缀，工厂内仍使用 `/v1` 路由。`pnpm prepare:web-deploy`
组装源码、依赖、平台入口和 Web 静态产物，并排除本地 `app/main.py`，避免出现
第二个 `/app/main` 入口。两端共用 `app.application:create_app`，不改变业务路由。
RAG 使用独立的 Node Agent 运行层，不随 Python API 部署。
