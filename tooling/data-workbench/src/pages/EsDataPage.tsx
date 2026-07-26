import { useCallback, useEffect, useState } from "react";
import { Button, Field, LoadingSpinner, TextInput } from "@jojo/ui";
import { PageTopbar } from "../components/PageTopbar";
import { OperationDialog } from "../components/OperationDialog";
import {
  apiGet,
  apiPost,
  type Migration,
  type SearchDocument,
} from "../lib/api";

type DialogState = {
  mode: "confirm" | "success" | "error";
  deleted?: boolean;
  title: string;
  message: string;
  details?: Array<{ label: string; value: string }>;
};

const emptyDocument: SearchDocument = {
  documentId: "",
  title: "",
  content: "",
  date: "",
  page: 0,
  source: "",
};

export function EsDataPage() {
  const [status, setStatus] = useState("正在检查连接…");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<SearchDocument[]>([]);
  const [selected, setSelected] = useState<SearchDocument>(emptyDocument);
  const [draft, setDraft] = useState<SearchDocument>(emptyDocument);
  const [reason, setReason] = useState("");
  const [migrations, setMigrations] = useState<Migration[]>([]);
  const [dialog, setDialog] = useState<DialogState>();

  const loadStatus = useCallback(() => {
    apiGet<{ success: boolean; index: string; activeDocuments: number }>(
      "/api/es-repair/status",
    )
      .then((data) =>
        setStatus(`${data.index} · ${data.activeDocuments} 条有效文档`),
      )
      .catch((error: Error) => setStatus(error.message));
  }, []);
  const loadMigrations = useCallback(() => {
    apiGet<{ success: boolean; items: Migration[] }>(
      "/api/es-repair/migrations",
    )
      .then((data) => setMigrations(data.items))
      .catch(() => setMigrations([]));
  }, []);

  useEffect(() => {
    loadStatus();
    loadMigrations();
  }, [loadMigrations, loadStatus]);

  async function search() {
    setLoading(true);
    try {
      const data = await apiPost<{ success: boolean; items: SearchDocument[] }>(
        "/api/es-repair/search",
        { query, size: 30 },
      );
      setResults(data.items);
    } catch (error) {
      setDialog({
        mode: "error",
        title: "搜索失败",
        message: (error as Error).message,
      });
    } finally {
      setLoading(false);
    }
  }

  function select(document: SearchDocument) {
    setSelected(document);
    setDraft({ ...document });
    setReason("");
  }

  function requestApply(deleted: boolean) {
    setDialog({
      mode: "confirm",
      deleted,
      title: deleted ? "确认标记删除" : "确认追加修复",
      message: deleted
        ? "文章将从正常搜索结果中隐藏，原始数据仍会保留。"
        : "系统会保留原文档，并追加一份完整的新版本。",
    });
  }

  async function apply() {
    if (!dialog || dialog.mode !== "confirm") return;
    const deleted = Boolean(dialog.deleted);
    setDialog(undefined);
    try {
      const data = await apiPost<{
        success: boolean;
        message: string;
        documentId: string;
        alreadyExists: boolean;
        migration: Migration;
      }>("/api/es-repair/apply", {
        supersedesId: selected.documentId,
        document: draft,
        deleted,
        reason,
        confirm: true,
      });
      setDialog({
        mode: "success",
        title: data.message,
        message: data.alreadyExists
          ? "相同 migration 此前已执行，本次没有产生重复版本。"
          : "新版本已写入，搜索索引可能需要几十秒完成刷新。",
        details: [
          { label: "Migration", value: data.migration.id },
          { label: "Document ID", value: data.documentId },
        ],
      });
      setSelected(emptyDocument);
      setDraft(emptyDocument);
      setReason("");
      loadMigrations();
      loadStatus();
    } catch (error) {
      setDialog({
        mode: "error",
        title: "执行失败",
        message: (error as Error).message,
      });
    }
  }

  async function replay(id: string) {
    try {
      await apiPost(`/api/es-repair/migrations/${id}/apply`);
      loadMigrations();
      loadStatus();
    } catch (error) {
      setDialog({
        mode: "error",
        title: "重试失败",
        message: (error as Error).message,
      });
    }
  }

  return (
    <>
      <PageTopbar
        eyebrow="SEARCH DATA / 搜索数据"
        title="ES 数据管理"
        aside={<span className="status-line">{status}</span>}
      />
      <main className="es-layout">
        <section className="paper-panel search-panel">
          <header>
            <p className="eyebrow">FIND</p>
            <h2>找到当前文档</h2>
          </header>
          <div className="panel-body">
            <form
              className="search-row"
              onSubmit={(event) => {
                event.preventDefault();
                void search();
              }}
            >
              <TextInput
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="标题、正文或来源"
              />
              <Button type="submit">搜索</Button>
            </form>
            <div className="search-results">
              {loading ? (
                <LoadingSpinner />
              ) : results.length === 0 ? (
                <p className="empty-copy">输入关键词，或直接搜索查看最近文档</p>
              ) : (
                results.map((item) => (
                  <button
                    className={`result-card ${selected.documentId === item.documentId ? "active" : ""}`}
                    key={item.documentId}
                    onClick={() => select(item)}
                  >
                    <b>{item.title || "(无标题)"}</b>
                    <span>
                      {item.date || "未知日期"} · {item.source || "未知来源"}
                    </span>
                    <p>{item.content?.slice(0, 150)}</p>
                  </button>
                ))
              )}
            </div>
          </div>
        </section>
        <section className="paper-panel edit-panel">
          <header>
            <p className="eyebrow">MIGRATE</p>
            <h2>追加修复版本</h2>
          </header>
          <div className="panel-body form-stack">
            <Field label="当前 documentId">
              <TextInput
                readOnly
                value={draft.documentId}
                placeholder="请先选择左侧文档"
              />
            </Field>
            <Field label="标题">
              <TextInput
                value={draft.title || ""}
                onChange={(event) =>
                  setDraft({ ...draft, title: event.target.value })
                }
              />
            </Field>
            <Field label="正文">
              <textarea
                rows={9}
                value={draft.content || ""}
                onChange={(event) =>
                  setDraft({ ...draft, content: event.target.value })
                }
              />
            </Field>
            <div className="form-grid">
              <Field label="日期">
                <TextInput
                  value={draft.date || ""}
                  onChange={(event) =>
                    setDraft({ ...draft, date: event.target.value })
                  }
                />
              </Field>
              <Field label="页码">
                <TextInput
                  type="number"
                  value={draft.page || 0}
                  onChange={(event) =>
                    setDraft({ ...draft, page: Number(event.target.value) })
                  }
                />
              </Field>
            </div>
            <Field label="来源">
              <TextInput
                value={draft.source || ""}
                onChange={(event) =>
                  setDraft({ ...draft, source: event.target.value })
                }
              />
            </Field>
            <Field label="修复原因">
              <TextInput
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="只写入本地 migration 文件"
              />
            </Field>
            <div className="button-row">
              <Button
                disabled={!selected.documentId}
                onClick={() => requestApply(false)}
              >
                确认追加修复
              </Button>
              <Button
                variant="outline"
                disabled={!selected.documentId}
                onClick={() => requestApply(true)}
              >
                标记删除
              </Button>
            </div>
            <p className="notice">
              修复原因只保存在本地 migration 文件，不会写入 ES。
            </p>
            <div className="migration-list">
              <h3>最近 migrations</h3>
              {migrations.length === 0 ? (
                <p>尚无 migration 文件</p>
              ) : (
                migrations.slice(0, 8).map((item) => (
                  <article key={item.id}>
                    <div>
                      <b>
                        {item.operation === "delete" ? "删除" : "修复"} ·{" "}
                        {item.state}
                      </b>
                      <code>{item.file}</code>
                      <span>{item.reason || "未填写原因"}</span>
                    </div>
                    {item.state === "pending" && (
                      <Button
                        variant="text"
                        onClick={() => void replay(item.id)}
                      >
                        重试
                      </Button>
                    )}
                  </article>
                ))
              )}
            </div>
          </div>
        </section>
      </main>
      <OperationDialog
        open={Boolean(dialog)}
        kicker={
          dialog?.mode === "success"
            ? "MIGRATION APPLIED"
            : dialog?.mode === "error"
              ? "MIGRATION FAILED"
              : dialog?.deleted
                ? "DELETE MIGRATION"
                : "REPAIR MIGRATION"
        }
        title={dialog?.title || ""}
        message={dialog?.message || ""}
        record={dialog?.mode === "confirm" ? selected.title : undefined}
        details={dialog?.details}
        confirmLabel={
          dialog?.mode === "confirm"
            ? dialog.deleted
              ? "确认标记删除"
              : "确认追加修复"
            : "完成"
        }
        cancelLabel={dialog?.mode === "confirm" ? "返回检查" : undefined}
        onConfirm={
          dialog?.mode === "confirm"
            ? () => void apply()
            : () => setDialog(undefined)
        }
        onClose={() => setDialog(undefined)}
      />
    </>
  );
}
