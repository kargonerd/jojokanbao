import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../../stores/authStore";
import { adminApi } from "../../api";
import { Card } from "@jojo/ui";

export function AdminLibraries() {
  const { token } = useAuthStore();
  const navigate = useNavigate();
  const [notebooks, setNotebooks] = useState<any[]>([]);

  useEffect(() => { if (token) adminApi.listNotebooks(token).then(setNotebooks); }, [token]);

  return (
    <div>
      <h1 className="text-xl font-bold text-ink mb-6">知识库管理</h1>
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
