import { useState, useEffect } from "react";
import { useAuthStore } from "../../stores/authStore";
import { adminApi } from "../../api";
import { Button, Field, ListItem, PageHeader, TextInput } from "@jojo/ui";

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
      <PageHeader title="账号管理" />
      <div className="flex gap-3 mb-6">
        <Field className="w-40">
          <TextInput value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="账号名称" className="w-full" />
        </Field>
        <Field className="flex-1">
          <TextInput value={newCookie} onChange={(e) => setNewCookie(e.target.value)} placeholder="Cookie" className="w-full" />
        </Field>
        <Button onClick={handleAdd}>添加</Button>
      </div>
      <div className="space-y-3">
        {accounts.map((acc: any) => (
          <ListItem
            key={acc.id}
            title={acc.name}
            meta={`${acc.notebooks?.length || 0} 个知识库`}
            actions={
              <>
              <Button variant="outline" onClick={() => handleRefresh(acc.id)}>刷新</Button>
              <button onClick={() => handleDelete(acc.id)} className="text-xs text-muted border-0 bg-transparent hover:text-red cursor-pointer">删除</button>
              </>
            }
          />
        ))}
      </div>
    </div>
  );
}
