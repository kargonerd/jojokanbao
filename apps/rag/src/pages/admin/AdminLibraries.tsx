import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../../stores/authStore";
import { adminApi } from "../../api";
import { Card, EmptyState, PageHeader } from "@jojo/ui";

export function AdminLibraries() {
  const { token } = useAuthStore();
  const navigate = useNavigate();
  const [notebooks, setNotebooks] = useState<any[]>([]);

  useEffect(() => { if (token) adminApi.listNotebooks(token).then(setNotebooks); }, [token]);

  return (
    <div>
      <PageHeader title="知识库管理" />
      {notebooks.length === 0 && <EmptyState title="暂无知识库" description="同步账号后会显示可管理的知识库" />}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {notebooks.map((nb: any) => (
          <Card key={nb.id} className="cursor-pointer p-4" onClick={() => navigate(`/admin/libraries/${nb.id}`)}>
            <h3 className="text-sm font-bold text-red m-0">{nb.title || nb.name}</h3>
            <p className="text-xs text-muted mt-1 m-0">{nb.sources_count || 0} 个来源</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
