import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAdminAuthStore } from "../../stores/adminAuthStore";
import { adminApi } from "../../api";
import { Button, Field, ListItem, PageHeader, TextInput } from "@jojo/ui";
import type { RagNotebook, RagSource } from "../../types";

export function AdminLibraryEditor() {
  const { notebookId } = useParams<{ notebookId: string }>();
  const { token } = useAdminAuthStore();
  const navigate = useNavigate();
  const [notebook, setNotebook] = useState<RagNotebook | null>(null);
  const [sources, setSources] = useState<RagSource[]>([]);
  const [title, setTitle] = useState("");

  useEffect(() => {
    if (!token || !notebookId) return;
    adminApi.listNotebooks(token).then((nbs) => {
      const nb = nbs.find((item) => item.id === notebookId);
      if (nb) { setNotebook(nb); setTitle(nb.title || ""); }
    });
    adminApi.listSources(token, notebookId).then(setSources);
  }, [token, notebookId]);

  async function handleSave() {
    if (!token || !notebookId) return;
    await adminApi.updateNotebook(token, notebookId, { title });
  }

  return (
    <div>
      <PageHeader title="编辑知识库" />
      {notebook && (
        <div className="space-y-4 max-w-lg">
          <Field label="标题">
            <TextInput value={title} onChange={(e) => setTitle(e.target.value)} className="w-full" />
          </Field>
          <Button onClick={handleSave}>保存</Button>
        </div>
      )}
      <h2 className="text-lg font-bold text-ink mt-8 mb-4">来源列表</h2>
      <div className="space-y-2">
        {sources.map((s) => (
          <ListItem
            key={s.id}
            title={s.title || s.name}
            meta={s.published ? "已发布" : "未发布"}
            className="cursor-pointer"
            onClick={() => navigate(`/rag/admin/libraries/${notebookId}/sources/${s.id}`)}
          />
        ))}
      </div>
    </div>
  );
}
