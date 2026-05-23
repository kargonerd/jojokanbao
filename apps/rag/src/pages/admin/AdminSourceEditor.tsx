import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { useAuthStore } from "../../stores/authStore";
import { adminApi } from "../../api";
import { Button } from "@jojo/ui";

export function AdminSourceEditor() {
  const { notebookId, sourceId } = useParams<{ notebookId: string; sourceId: string }>();
  const { token } = useAuthStore();
  const [title, setTitle] = useState("");
  const [published, setPublished] = useState(false);

  useEffect(() => {
    if (!token || !notebookId) return;
    adminApi.listSources(token, notebookId!).then((sources) => {
      const s = sources.find((x: any) => x.id === sourceId);
      if (s) { setTitle(s.title || ""); setPublished(!!s.published); }
    });
  }, [token, notebookId, sourceId]);

  async function handleSave() {
    if (!token || !notebookId || !sourceId) return;
    await adminApi.updateSource(token, notebookId, sourceId, { title, published });
  }

  return (
    <div>
      <h1 className="text-xl font-bold text-ink mb-6">编辑来源</h1>
      <div className="space-y-4 max-w-lg">
        <div>
          <label className="block text-xs font-bold text-muted mb-1">标题</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full h-9 text-sm" />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} className="accent-[var(--color-red)]" />
          已发布
        </label>
        <Button onClick={handleSave}>保存</Button>
      </div>
    </div>
  );
}
