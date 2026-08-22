# JOJO Times 离线新闻系统设计

状态：设计基线，2026-08-23。

## 1. 目标

JOJO Times 每十分钟离线发现新闻、保存原始网络响应、提取结构化正文并发布到 B2。Web、Mobile
和后续 Agent 只读取 B2 CDN 或搜索索引，不在用户请求路径中访问出版方、RSSHub 或 Python API。

首期生产目录为 20 家来源。WSJ 已移除；财新不在目录中。

核心目标：

1. 单一来源失败不阻断其他来源，也不删除上一轮已发布内容。
2. RSSHub 已稳定返回正文时直接消费正文；只有需要原页解析或存档时才抓文章页。
3. 每次抓取都可重放、可重新解析：原始 feed 和文章 HTTP 交换写入 WARC 1.1/WACZ 1.2。
4. 发布是幂等且有提交顺序的；CDN 不会看到引用尚未上传对象的 manifest。
5. 翻译和 ES 是 Canonical 的下游消费者，不侵入采集器，也不改变前端对象地址规则。

## 2. 系统边界

```text
GitHub Actions（每 10 分钟，single-flight）
  │
  ├─ 发现层：官方 RSS / RSSHub / 站点发现适配器
  ├─ 归一化：时间、canonical URL、稳定 article id、7 天窗口、去重
  ├─ 正文层：feed 正文 → 已锁定解析器 → HTTP/浏览器兜底
  ├─ 存档层：WARC + CDXJ + pages.jsonl → WACZ
  ├─ Canonical：可重建、与交付格式解耦的文章真值
  ├─ 派生层：翻译、ES documents（可选）
  └─ 提交层：不可变对象 → manifest → availability/index/latest → catalog
                         │
                         ▼
                 B2 private raw / B2 CDN delivery
                         │
                   Web / Mobile / Agent
```

Times 不恢复实时抓取 API。运行入口只保留 CLI 和 `maintenance-times.yml`。

## 3. 来源策略

### 3.1 当前生产分组

| 分组 | 来源 | 首选内容 | 原页用途 |
|---|---|---|---|
| RSSHub 正文优先 | 人民网、央视新闻、中国新闻网、澎湃新闻、第一财经、财联社、证券时报 | `feed-body` | 原始 HTML 存档、抽样校验、未来离线重解析 |
| RSS/路由发现 + runner | AP、Bloomberg、NYT、Reuters、FT、Axios、NPR、Nikkei、联合早报、Al Jazeera、SCMP | 已锁定出版方 parser；失败时保留摘要 | WACZ 与正文解析 |
| 发现 + 待补 parser | The Guardian、新华网 | Guardian 官方 World RSS；新华网暂用站点限定发现 RSS | 必须抓原页；补专用 parser 后产出稳定全文 |

Axios、NPR 的 feed 经常包含长文本，但在逐篇原页一致性和持续稳定性通过前，不因长度大就自动切换
`feed-body`。新华网长期方案应是自有站点发现适配器，Google News 只作为过渡发现层。

### 3.2 配置演进

当前 `sources.json` v1 足以表达 `route/feedUrl`、`contentPolicy`、`parserId` 和是否存档。下一阶段升级
到 v2，将发现、正文和存档拆成三个显式策略，避免用一个字段暗示整个抓取流程：

```json
{
  "id": "people",
  "discovery": { "kind": "rsshub", "route": "/people" },
  "content": { "priority": ["feed-body", "archive-parser"] },
  "archive": { "mode": "http-first", "browserFallback": true },
  "health": { "maximumAgeMinutes": 180, "minimumItems": 1 }
}
```

迁移时继续读取 v1；全部来源转成 v2 后再提升配置版本，不进行一次性破坏性迁移。

## 4. 单轮运行协议

1. 从 Delivery B2 下载 `latest.jox`、`index.jox`、`catalog.jox`；从 Raw B2 下载 archive state 和
   保留窗口内的 Canonical issue。
2. 并行请求全部发现源。429 和 5xx 使用 1 秒、3 秒有限重试；每家状态单独记录。
3. 只接收出版方明确给出发布时间、且在 7 天窗口内的条目。canonical URL 与来源共同生成稳定 ID。
4. 合并上一轮 `latest`，因此某家本轮失败不会让其尚在窗口内的文章消失。
5. 正文按优先级选择：
   - 已验证 `feed-body`：立即形成正文，原页抓取不阻塞正文交付；
   - 有出版方 parser：抓原页后调用 runner；
   - parser 不支持或失败：保留 feed 摘要和归档，等待离线重解析。
6. 增量选择需要归档的 URL：新文章优先、内容指纹变化次之、失败重试再次、24 小时刷新最后；每轮
   保证每个有候选的来源至少一篇，再填满全局预算。
7. 归档采用 HTTP-first。静态页面保存重定向链和最终响应；遇到 JS 页面、403/429 或来源显式要求时
   才启用 Playwright/Browsertrix。浏览器捕获保存页面及同页关键响应，但受每页字节和时间预算约束。
8. 构建 WACZ、Canonical、Delivery Jox 和当轮 ES JSONL；在发布前完成本地引用完整性校验。
9. 按第 6 节顺序提交 B2。只有不可变依赖均成功后才推进 `latest` 等可变指针。
10. 输出脱敏 `report.json`；错误只记录类型、HTTP 状态、时延和计数，不写访问 key、Cookie 或代理信息。

## 5. 存储契约

### 5.1 Raw B2（私有）

```text
raw/web-archives/times/YYYY/MM/DD/RUN_ID/times-RUN_ID.wacz
raw/web-archives/times/YYYY/MM/DD/RUN_ID/run.json
raw/web-archives/times/state.json.gz
canonical/news-articles/{parser-or-source}/YYYY/MM/{article-id}-{hash}.json.gz
canonical/newspapers/times/items/YYYY/MM/YYYY-MM-DD.json.gz
```

WACZ 是原始证据；Canonical 是可从 WACZ 重建、但供后续处理稳定消费的真值。二者都不由前端直接
枚举。鉴权 header、Cookie、RSSHub key、代理认证以及 `Set-Cookie` 不写入 WARC。

### 5.2 Delivery B2（CDN）

```text
catalog.jox
content/newspapers/times/latest.jox
content/newspapers/times/index.jox
content/newspapers/times/availability/YYYY.jox
content/newspapers/times/items/YYYY/MM/YYYY-MM-DD/manifest.jox
content/newspapers/times/items/YYYY/MM/YYYY-MM-DD/articles/*.jox
```

Article Jox 内容寻址、长期 immutable；manifest 和各级指针允许 60 秒重新验证。前端从
`latest.jox` 或 `index.jox` 进入，不猜测 B2 目录，也不读取 Raw bucket。

## 6. 发布事务与恢复

发布顺序固定为：

1. Raw WACZ、run metadata、Canonical；
2. Raw archive state；
3. Delivery Article；
4. 当日 manifest；
5. availability；
6. index；
7. latest；
8. 仅在 Times 注册项变化时更新全局 catalog。

1–3 阶段失败不会改变读者可见指针，可以安全重跑。4–8 阶段使用内容校验和上传；重跑同一个构建
不会产生不同的 Article 地址。`latest` 发布失败时，下轮从旧指针重新合并并补交，不执行远端删除。

## 7. 运行预算和健康度

- GitHub Actions 使用固定 concurrency group，任何时刻最多一个发布任务。
- 十分钟是触发频率，不假定 GitHub cron 精确准点。任务应设置 8 分钟软预算，在第 6 分钟停止领取
  新的浏览器抓取，预留构建和指针提交时间；硬超时不得落在提交可变指针的中间。
- 每轮页面预算保持上限，积压通过后续轮次消化。feed 正文不受页面预算影响。
- 单源健康指标：feed 成功率、最新文章年龄、条目数、正文/摘要比例、原页比对差异、归档成功率、
  parser complete/partial/error。
- 连续异常只降低该源到“发现/摘要”或暂缓原页抓取，不自动从目录删除，也不阻断其他来源。
- 财联社当前已有瞬时 503 证据，有限重试是必需项；禁止无限重试拖垮整轮。

## 8. 翻译和搜索扩展点

翻译器读取 Canonical，不读取 WACZ，也不重新访问出版方。译文包含原文内容哈希、语言、模型和提示词
版本；原文变化时生成新的派生版本。发布译文会形成新的内容寻址 Article，再原子推进 manifest。

ES 发布器消费当轮 `search/times/runs/RUN_ID/documents.jsonl.gz` 或从 Canonical 重建。JSONL 是传输
产物，不是长期真值；索引失败不能回滚新闻 CDN 发布。后续可增加独立 search checkpoint，确保
at-least-once 写入和幂等 document id。

## 9. 实施阶段

### Phase 0：目录收敛（当前）

- 生产目录固定为 20 家；移除 WSJ 和财新。
- 7 家验证通过的大陆来源启用 RSSHub `feed-body`。
- 所有 feed 瞬时错误使用有限重试；配置和审计进入 CI。

验收：目录测试通过；单源 503 不影响其他来源；任何报告不含 secret。

### Phase 1：来源可靠性

- 连续运行 72 小时健康监测，确认时效、条目数和正文一致性，而非只看 HTTP 200。
- 为 Guardian、新华网增加 runner parser；为新华网增加自有发现适配器。
- 复核 Axios、NPR 是否可提升为 `feed-body`。

验收：每家至少 20 篇人工/自动抽样；正文与原页一致；失败时正确降级为摘要。

### Phase 2：分层归档

- 把全局 `archive-engine` 改成来源级 HTTP-first + browser fallback。
- 增加软时间预算、积压计数、浏览器触发原因和 WACZ replay 自动 QA。
- 保持 WARC/WACZ 和 B2 key 不变，前端不受迁移影响。

验收：公开静态源不启动 Chrome；JS/反爬源能触发兜底；WACZ 可由自建 replay 与
ReplayWeb.page 打开。

### Phase 3：B2 staging 与上线

- 连续 24 小时 dry-run，只生成报告和 staging 对象，不推进生产 `latest`。
- 校验对象引用、缓存头、增量合并和失败恢复后，启用十分钟生产发布。
- Web/Mobile 切到 B2 CDN；旧实时 Times API 保持删除状态。

验收：前端断开后端仍可读；任一 Action 中断后 CDN 指针仍引用完整对象；下轮能自动恢复。

### Phase 4：翻译和 ES

- 翻译器与 ES 发布器作为独立 job 消费 Canonical/checkpoint。
- 为派生数据增加版本、监控和重放命令，不修改采集任务的成功定义。

验收：翻译或 ES 故障不影响原文发布；清空索引后可完全由 Canonical 重建。

## 10. 当前不做

- 不把用户代理订阅放入生产工作流。
- 不在前端或 Agent 请求期间抓新闻。
- 不把 RSS 字符数当作全文证明。
- 不用 ES、翻译结果或 Delivery Jox 反向充当 Canonical 真值。
- 不为恢复失败运行而删除整个 B2 前缀。
