import { useState, useEffect } from "react";
import { useAuthStore } from "../../stores/authStore";
import { adminApi } from "../../api";
import { Button, Card } from "@jojo/ui";

export function AdminAccounts() {
  const { token } = useAuthStore();
  const [accounts, setAccounts] = useState<any[]>([]);
  const [newCookie, setNewCookie] = useState("");
  const [newName, setNewName] = useState("");

  useEffect(() => { if (token) loadAccounts(); }, [token]);

  async function loadAccounts() { setAccounts(await adminApi.getAccounts(token!)); }

  async function handleAdd() {
    if (!newCookie.trim() || !newName.trim()) return;
    await adminApi.addAccount(token!, { name: newName, cookie: newCookie });
    setNewCookie(""); setNewName("");
    loadAccounts();
  }

  async function handleRefresh(id: string) { await adminApi.refreshAccount(token!, id); loadAccounts(); }
  async function handleDelete(id: string) { if (confirm("确定删除？")) { await adminApi.deleteAccount(token!, id); loadAccounts(); } }

  return (
    <div>
      <h1 className="text-xl font-bold text-ink mb-6">账号管理</h1>
      <div className="flex gap-3 mb-6">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="账号名称" className="h-9 text-sm w-40" />
        <input value={newCookie} onChange={(e) => setNewCookie(e.target.value)} placeholder="Cookie" className="h-9 text-sm flex-1" />
        <Button onClick={handleAdd}>添加</Button>
      </div>
      <div className="space-y-3">
        {accounts.map((acc: any) => (
          <Card key={acc.id} hover={false} className="p-4 flex items-center justify-between">
            <div>
              <p className="font-bold text-ink m-0">{acc.name}</p>
              <p className="text-xs text-muted mt-1 m-0">{acc.notebooks?.length || 0} 个知识库</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => handleRefresh(acc.id)}>刷新</Button>
              <button onClick={() => handleDelete(acc.id)} className="text-xs text-muted border-0 bg-transparent hover:text-red cursor-pointer">删除</button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
