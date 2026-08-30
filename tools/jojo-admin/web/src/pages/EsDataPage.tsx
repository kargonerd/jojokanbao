import { useCallback, useEffect, useState } from "react";
import { Button, Field, LoadingSpinner, TextInput } from "@jojo/ui";
import { PageTopbar } from "../components/PageTopbar";
import { OperationDialog } from "../components/OperationDialog";
import { MigrationPreviewDialog } from "../components/MigrationPreviewDialog";
import {
  apiGet,
  apiPost,
  type Migration,
  type MigrationPreview,
  type SearchDocument,
} from "../lib/api";

type DialogState = {
  mode: "success" | "error";
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
  const [preview, setPreview] = useState<MigrationPreview>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [publishingState, setPublishingState] = useState(false);

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

  async function requestPreview(deleted: boolean) {
    setPreviewLoading(true);
    try {
      const data = await apiPost<MigrationPreview & { success: boolean }>(
        "/api/es-repair/preview",
        {
          replacedDocumentId: selected.documentId,
          document: draft,
          deleted,
          reason,
        },
      );
      setPreview(data);
    } catch (error) {
      setDialog({
        mode: "error",
        title: "无法生成预览",
        message: (error as Error).message,
      });
    } finally {
      setPreviewLoading(false);
    }
  }

  async function apply() {
    if (!preview) return;
    setApplying(true);
    try {
      const data = await apiPost<{
        success: boolean;
        message: string;
        documentId: string;
        alreadyExists: boolean;
        migration: Migration;
      }>("/api/es-repair/apply", {
        replacedDocumentId: preview.migration.replacedDocumentId,
        document: preview.migration.document,
        deleted: preview.migration.operation === "delete",
        reason: preview.migration.reason,
        previewHash: preview.previewHash,
      });
      setPreview(undefined);
      setDialog({
        mode: "success",
        title: data.message,
        message: data.alreadyExists
          ? "相同 migration 此前已执行；远端搜索修订状态也已同步。"
          : "新版本和远端搜索修订状态均已写入，搜索索引可能需要几十秒完成刷新。",
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
      setPreview(undefined);
      setDialog({
        mode: "error",
        title: "执行失败",
        message: (error as Error).message,
      });
    } finally {
      setApplying(false);
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

  async function publishState() {
    setPublishingState(true);
    try {
      const data = await apiPost<{
        success: boolean;
        searchState: { object: string; excluded: number };
      }>("/api/es-repair/publish-state");
      setDialog({
        mode: "success",
        title: "搜索修订状态已发布",
        message: `当前共排除 ${data.searchState.excluded} 个旧版本。`,
        details: [{ label: "COS Object", value: data.searchState.object }],
      });
    } catch (error) {
      setDialog({
        mode: "error",
        title: "状态发布失败",
        message: (error as Error).message,
      });
    } finally {
      setPublishingState(false);
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
              <Button type="submit" disabled={loading}>
                {loading ? "正在搜索…" : "搜索"}
              </Button>
            </form>
            <div className="search-results">
              {loading ? (
                <div className="search-loading" role="status">
                  <LoadingSpinner />
                  <div>
                    <b>正在查询 ES</b>
                    <span>腾讯云 Kibana 转发通常需要数秒，请稍候。</span>
                  </div>
                </div>
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
                      {item.type ? `${item.type} · ` : ""}
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
              {!draft.type && (
                <Field label="页码">
                  <TextInput
                    type="number"
                    value={draft.page || 0}
                    onChange={(event) =>
                      setDraft({ ...draft, page: Number(event.target.value) })
                    }
                  />
                </Field>
              )}
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
                disabled={!selected.documentId || previewLoading}
                onClick={() => void requestPreview(false)}
              >
                {previewLoading ? "正在生成预览…" : "预览修复 migration"}
              </Button>
              <Button
                className="delete-action"
                variant="outline"
                disabled={!selected.documentId || previewLoading}
                onClick={() => void requestPreview(true)}
              >
                预览删除墓碑
              </Button>
            </div>
            <p className="notice">
              预览不会写文件或 ES；再次确认后才执行。修复原因只保存在本地
              migration 文件。
            </p>
            <div className="migration-list">
              <div className="button-row">
                <h3>最近 migrations</h3>
                <Button
                  variant="text"
                  disabled={publishingState}
                  onClick={() => void publishState()}
                >
                  {publishingState ? "正在发布状态…" : "重新发布搜索状态"}
                </Button>
              </div>
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
      <MigrationPreviewDialog
        preview={preview}
        applying={applying}
        onApply={() => void apply()}
        onClose={() => setPreview(undefined)}
      />
      <OperationDialog
        open={Boolean(dialog)}
        kicker={
          dialog?.mode === "success"
            ? "MIGRATION APPLIED"
            : "MIGRATION FAILED"
        }
        title={dialog?.title || ""}
        message={dialog?.message || ""}
        details={dialog?.details}
        confirmLabel="完成"
        onConfirm={() => setDialog(undefined)}
        onClose={() => setDialog(undefined)}
      />
    </>
  );
}
