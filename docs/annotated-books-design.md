# 批注书籍与关联内容设计

状态：设计稿（未实现）。本文描述批注类书籍的总体设计：内容模型、制作管线、阅读体验、
分发形态与落地分期。术语遵循 [data-format-v1](./data-format-v1.md) 的
Raw / Canonical / Delivery 分层。

## 1. 目标

- 支持以「批注版书籍」为核心的内容形态：在原著正文之上叠加批注者（如阳老师）的
  批注、注释与讲解资源，读者可在批注下讨论。
- 通用化：批注只是「书籍关联内容」的一种类型。同一套模型需支撑毛选等著作的
  人物注、事件注、背景注、报刊原文引用、讲解视频等关联需求。
- 复用现有设施：书籍发布走 content-pipeline 与 B2 Delivery，读者讨论走现有
  annotations（想法）体系，不新建后端、不新增用户表。

## 2. 总体架构：三机制 × 四级锚点

书籍正文之外的关联内容收敛为三个机制，全部可锚定在四级粒度上：

| 机制 | 性质 | 存储 | 分发 |
|------|------|------|------|
| note（注） | 编辑制作的静态文字 | Canonical | Delivery（站内阅读）+ EPUB 导出 |
| link（链） | 资源引用（站内或外链），编辑部与用户均可创建 | Supabase | 仅站内（用户 link 先审后显） |
| 讨论（UGC） | 读者生成的想法与回复 | Supabase（现有 annotations 体系） | 仅站内 |

锚点四级：书级（book）、章级（chapter）、段级（paragraph）、句级（sentence）。

### 2.1 决策记录：存储分层

- **note 进 Canonical**：批注与注释是书籍内容的一部分，随书版本化、可离线、
  可随 EPUB 分发。EPUB 与 Delivery 均为 Canonical 的派生物，从同一真值生成，
  天然一致。
- **link 存 Supabase**：link 由编辑部与用户在阅读过程中持续创建，是动态增长的
  数据，不是随书定稿的制作产物；存 Supabase 直接复用 UGC 的建表、账号与审核
  体系，新增或修订 link 不需要走 content-pipeline 重发书籍版本。代价：link
  不随 EPUB 分发、不进检索索引。
- **讨论存 Supabase**：讨论是真 UGC，复用现有 `annotations` 表与 RPC
  （划线、想法、楼中楼回复、点赞、举报均已有），零新表。
- **创建与审核**：编辑部账号（如「JOJO 编辑部」）在阅读器内边看书边创建
  link，创建后直接生效；用户提交的 link 进入待审队列，审核通过后展示
  （先审后显）。审核工作台复用 `tools/jojo-admin` 的报刊人工审核模式。
- **官方身份是配置，不是专属账号**：批注者与官方 link 的展示身份名单
  （authorId → 名称、颜色、徽章）放 PostHog Remote config；账号 authorId
  加入名单即获得官方样式。「JOJO 编辑部」即名单中的一个真实运营账号。

### 2.2 数据模型

Canonical 书籍对象新增一个数组，Supabase 新增一张 link 表；type 均为开放枚举，
阅读器对未知 type 渲染通用卡片，保证后续新增类型不需要发版。

```
notes[]: {
  id          // 稳定 id，如 {bookId}:n:{ord}
  anchor      // { level: sentence|paragraph|chapter|book, ...定位信息 }
  type        // annotation | background | person | event | concept
              // | citation | edition | gloss | preface | exercise ...
  author?     // 批注者标识（官方名单中的 key）
  title?      // 卡片标题（如人物注的人名）
  body        // 正文（受限行内格式）
  video?      // 讲解视频：{ bvid, t? }（t 为秒级时间戳）
  page?       // 原页码（对照扫描页用）
  ord
}
```

- `annotation` 类型的 note 即「批注」；其余类型为客观注释（人物、事件、版本考据等）。

links 存 Supabase（新表 `book_links`）：

```
book_links: {
  id
  book_id
  anchor      // { level: sentence|paragraph|chapter|book, ...定位信息 }
  type        // video | audio | newspaper | book | book-chapter | article
              // | person | event | concept | timeline | external ...
  ref         // { contentId, sectionId? }（站内）或 { url }（站外）
  title
  created_by  // 创建账号（编辑部或用户）
  status      // pending | approved | rejected
  created_at
}
```

- 编辑部账号创建的 link 入库即 `approved`，直接生效；用户提交的 link 为
  `pending`，审核通过后才对所有人可见（先审后显），提交者本人可见自己的待审
  link。展示时按 anchor 聚合，官方与用户 link 同一卡片体系，以来源徽章区分。
- `newspaper` 类型的 link 指向站内报刊档案（按日期/版面定位），实现
  「正文提到某事件 → 跳转当年报纸原文」的站内闭环，是独有的差异化能力。
- 讨论不新增任何模型：批注句的讨论 = 该句 anchor 下现有 thread 的 comments。

## 3. 制作管线

输入是批注版 PDF（或自带注释的原书），输出是 Canonical 的 notes 源数据。

1. **正文结构化**：扫描件经 MinerU vlm OCR（约 1.1 s/页）得到段落文本与行 bbox；
   原书自带注释（如毛选每页脚注）在同一遍 OCR 中提取为候选 notes。
2. **批注提取**：PyMuPDF 解析批注 PDF。打字批注（Stamp）经字体 ToUnicode
   直解为文字与坐标，无需 OCR；墨迹（Ink）取下划线/圈框几何范围。
3. **锚定对齐**：Ink bbox 与 OCR 行 bbox 求交，得到句级锚点；页边批注归属最近
   下划线或段落；无下划线依附的独立批注降级为段批或章批。**锚点必须对
   content-pipeline 最终产物文本计算**（阅读器经 domAnchors 在 DOM 重定位，
   文本不一致会导致锚点漂移）。
4. **人工校对**：`tools/` 内的关联内容编辑台——左原页图、右结构化结果，
   修锚点、改文字、配视频链接、定稿。编辑台同时承担发布前验收视图。
5. **入库**：校对后的源 JSON 写入 Canonical（Hugging Face Dataset），随书籍发布
   流程生成 Delivery（jox）与 EPUB。

link 不走上述管线：由编辑部账号在阅读器内选中文字直接创建，写入 `book_links`
即生效；用户 link 同入口提交，进待审队列。

## 4. 阅读体验

### 4.1 划线视觉语言（颜色区分来源，标记区分类型）

| 来源 | 样式 |
|------|------|
| 官方批注 | 批注者专属色实线下划线 + 淡色底（默认展开优先） |
| 我的划线 | 墨色实线（现样式由红色波浪线改为墨色，红色让给官方） |
| 其他读者 | 灰色点线（维持现状） |

批注者专属色随官方名单配置下发（建议黛蓝 `#2F4B7C`，传统「蓝批」语义，
与品牌红形成来源对比）。类型不参与配色，由上标标记区分：批注、注
（人物/事件/概念）、报（报刊引用）等。

### 4.2 卡片与讨论

- 句批：点划线弹出批注卡（批注者、被批原文、批注正文、视频按钮、讨论入口），
  读者想法聚合在批注下方；官方批注置顶，读者想法可折叠。
- 段批/章批/篇级题解：不依附句下划线，渲染为段落末尾标记、章首卡片。
- 筛选器：只看批注 / 只看读者 / 全部，默认批注优先。
- 章首批注目录与「上一条/下一条」导览模式，配合讲解视频形成课程式阅读。
- 讲解视频：批注卡内嵌 B 站播放器（`player.bilibili.com` iframe），支持时间戳；
  章级视频渲染为章首横幅卡。
- link：锚点处渲染链接标记，点开为链接卡（标题、来源徽章、目标资源入口）；
  官方 link 与用户 link 同一卡片体系，按来源徽章区分。用户 link 审核通过后
  才对所有人可见，提交者本人可见自己的待审 link。

## 5. EPUB 导出

EPUB 由 Canonical 重建，批注版 EPUB 将 notes 烘为排版内容，任何阅读器可见：

- 句批：正文句后专属色上标 `[n]`，链接至章末批注小节；声明
  `epub:type="noteref"`，支持的阅读器（Apple Books 等）弹窗显示。
- 段批：段后批注块；章批与题解：章首块。
- link 存 Supabase，不随 EPUB 分发；讨论与 AI 问答同样不随 EPUB 分发。
- 干净版与批注版作为两个 export 并存（现有 `downloadExport` 按 exportId
  选择描述符，机制不变）。

注意：EPUB 一经下载无法回收，批注修订只影响后续下载；发布前须经编辑台验收。

## 6. AI / 检索闭环

notes 随 Canonical 进入检索索引后，AI 回答（RAG）可引用批注与注释原文，
实现「问《论持久战》核心论点 → 回答引用批注者观点」。批注因此从展示层内容
升级为可检索的知识资产。

## 7. 落地分期

1. **MVP（阳批《经济学原理》前言 + 第一章，19 页）**：管线 1–3 步 + 只读批注渲染
   （句批 + 讲解视频 link 两个类型），验证锚定精度与阅读体验；`book_links` 表、
   阅读器创建入口与审核队列在本期一并落地。
2. **二期**：讨论挂载与筛选器、批注版/干净版双 EPUB、关联内容编辑台。
3. **三期（毛选等著作）**：人物/事件/概念注、报刊原文 link、题解、书级附录
   （术语表、年表）、导览模式、AI 引用闭环。

## 8. 风险与开放问题

- **版权**：在版教材与授权著作的全文展示需评估展示策略（批注为主体、
  原文最小必要引用，或邀请制范围）。批注本身属二次创作。
- **手写批注**：打字批注可程序化直解；手写批注需 OCR，准确率显著下降。
  制作规范建议批注者使用打字批注。
- **锚点稳定性**：正文重排（content-pipeline 版本升级）可能导致历史批注锚点
  漂移，需在编辑台提供批量校验与修复入口；`book_links` 为动态数据，同样需要
  批量校验覆盖。
- **审核与质量**：用户 link 先审后显，审核积压会压制投稿意愿；外链需成文
  内容规范（如禁止纯推广链接），审核标准与报刊人工审核对齐。
