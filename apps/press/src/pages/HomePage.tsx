import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card } from "@jojo/ui";

interface Project { id: string; name: string; status: string; createdAt: string }

export function HomePage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [creating, setCreating] = useState(false);

  // In Electron, projects come from IPC. For web preview, use mock data.
  const handleCreate = async () => {
    setCreating(true);
    // TODO: IPC call to create project (upload PDF, run OCR)
    setCreating(false);
  };

  return (
    <div className="h-screen flex flex-col bg-paper">
      <header className="h-14 flex items-center justify-between px-6 border-b border-rule-dark shrink-0">
        <h1 className="text-lg font-bold text-red tracking-wider m-0">JOJO Press</h1>
        <Button onClick={handleCreate} className={creating ? "opacity-50" : ""}>新建项目</Button>
      </header>
      <main className="flex-1 overflow-y-auto p-6">
        {projects.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-xl font-bold text-ink mb-2">暂无项目</p>
            <p className="text-sm text-muted">点击"新建项目"上传 PDF 开始校对</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-5xl mx-auto">
            {projects.map((p) => (
              <Card key={p.id} className="p-4 cursor-pointer" onClick={() => navigate(`/project/${p.id}/proofread`)}>
                <h3 className="text-sm font-bold text-red m-0">{p.name}</h3>
                <p className="text-xs text-muted mt-1 m-0">{p.status} · {p.createdAt}</p>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
