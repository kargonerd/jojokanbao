# 项目诊断报告：自动化溯源系统的链接准确性问题

## 1. 当前系统架构 (Current Implementation)

系统采用 **Node.js (Server) + Gemini CLI (Executor) + Tailwind (UI)** 的三层结构：

- **前端 (`dynamic_demo.html`)**：用户输入 URL，通过 SSE (Server-Sent Events) 接收实时分析日志和最终 HTML 结果。
- **后端代理 (`server_all.js`)**：
    1. 使用原生 `fetch` 抓取目标网页 HTML。
    2. 自动构建包含网页上下文的 **"Senior News Editor"** 复杂 Prompt。
    3. 通过 `child_process.spawn` 启动 `gemini -y` (YOLO 模式) 进行后台处理。
- **后台执行 (`Gemini CLI`)**：
    - 执行 `google_web_search` 搜索历史节点。
    - 对比最新新闻与历史承诺。
    - 生成带 Tailwind 类名的 HTML 代码。

## 2. 核心问题描述 (The "Hallucination" Bug)

尽管 Gemini CLI 在后台调用了 `google_web_search` 并返回了包含正确信息的搜索结果，但在 **“合订本” HTML 生成阶段**，AI 出现了严重的**链接预测/幻觉问题**：

1.  **路径猜测**：AI 倾向于根据新闻标题猜测 NASA 或 NYT 的 URL 结构（例如把 `RELEASE 24-006` 猜测为 `nasa.gov/news-release/24-006/`），而不是从搜索结果的 `Source URI` 中精确复制。
2.  **链接失效**：生成的 HTML 中 80% 的 `<a>` 标签指向的是 404 页面或错误的路径。
3.  **验证缺失**：虽然搜索工具提供了真实链接，但生成器在拼装 HTML 时并未强制执行“链接有效性二次校验”。

## 3. 待解决任务 (Requirements for Next AI)

下一个 AI 需要针对以下几点进行修复：

1.  **强约束 Prompt 优化**：修改 `server_all.js` 中的 Prompt 模板，明确要求 AI：
    - “必须从搜索结果的 `Source URI` 字段中 100% 原始复制链接，严禁修改任何字符。”
    - “如果没有找到对应的真实 URL，严禁猜测，必须标注为 [Link Missing]。”
2.  **增加验证环节**：在生成的 HTML 返回给前端前，增加一个正则表达式提取所有 URL 并进行 HEAD 请求校验（可选）。
3.  **输出一致性**：确保生成的时间线节点与搜索结果中的关键证据链（Evidence Chain）完全一一对应。

## 4. 相关文件位置
- **逻辑核心**：`server_all.js`
- **UI 模板**：`dynamic_demo.html`
- **当前 Prompt 定义**：`server_all.js` 第 82-108 行。
