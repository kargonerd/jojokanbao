import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageTopbar } from "../components/PageTopbar";
import { apiGet } from "../lib/api";

export function OverviewPage() {
  const [esState, setEsState] = useState("正在检查连接…");

  useEffect(() => {
    apiGet<{ success: boolean; index: string; activeDocuments: number }>(
      "/api/es-repair/status",
    )
      .then((data) =>
        setEsState(`${data.index} · ${data.activeDocuments} 条有效文档`),
      )
      .catch(() => setEsState("ES 连接异常"));
  }, []);

  return (
    <>
      <PageTopbar
        eyebrow="DATA OPERATIONS / 数据运营"
        title="JOJO 管理台"
        aside={
          <span className="local-badge">
            <i />
            本地管理环境
          </span>
        }
      />
      <main className="overview">
        <section className="overview-hero">
          <div>
            <p className="eyebrow">JOJO KANBAO</p>
            <h2>
              从报刊文件到可搜索数据，
              <br />
              在一个管理台完成。
            </h2>
            <p>
              管理内容入库、搜索索引和产品运行规则。每项操作保留清晰边界与可核验结果。
            </p>
          </div>
          <time>
            {new Intl.DateTimeFormat("zh-CN", { dateStyle: "full" }).format(
              new Date(),
            )}
          </time>
        </section>
        <section className="module-section">
          <header>
            <div>
              <p className="eyebrow">MODULES</p>
              <h2>数据管理模块</h2>
            </div>
            <span>6 个模块可用</span>
          </header>
          <div className="module-grid">
            <Link className="module-card" to="/pdf">
              <span className="module-code">PDF</span>
              <h3>PDF 数据管理</h3>
              <p>
                扫描报刊文件，完成命名识别、页面拆分、存储提交与发布代码检查。
              </p>
              <footer>
                <span>进入模块</span>
                <b>→</b>
              </footer>
            </Link>
            <Link className="module-card" to="/es">
              <span className="module-code">ES</span>
              <h3>ES 数据管理</h3>
              <p>
                检索当前有效文档，通过 append-only migration
                修复或逻辑删除搜索数据。
              </p>
              <footer>
                <span>{esState}</span>
                <b>→</b>
              </footer>
            </Link>
            <Link className="module-card" to="/content">
              <span className="module-code">JOX</span>
              <h3>书籍内容管理</h3>
              <p>导入并发布书籍 JSON、清单与 Jox 内容对象。</p>
              <footer><span>进入模块</span><b>→</b></footer>
            </Link>
            <Link className="module-card" to="/features">
              <span className="module-code">FLAG</span>
              <h3>功能开关</h3>
              <p>按顺序配置用户名单、百分比灰度和全局默认规则。</p>
              <footer><span>进入运行控制</span><b>→</b></footer>
            </Link>
            <Link className="module-card" to="/agent">
              <span className="module-code">AGENT</span>
              <h3>Agent 管理</h3>
              <p>检查本机 Codex OAuth，并通过 Operator 接口更新部署端凭据。</p>
              <footer><span>进入 Agent 运维</span><b>→</b></footer>
            </Link>
            <Link className="module-card" to="/rmrb-review">
              <span className="module-code">RMRB</span>
              <h3>人民日报缺失正文</h3>
              <p>按人民数据目录复核本地两份来源均未提供正文的记录，只生成 staging 决策。</p>
              <footer><span>进入人工复核</span><b>→</b></footer>
            </Link>
          </div>
        </section>
      </main>
    </>
  );
}
