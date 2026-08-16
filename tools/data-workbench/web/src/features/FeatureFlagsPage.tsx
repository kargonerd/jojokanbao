import { useEffect, useMemo, useState, type FormEvent } from "react";
import { PageTopbar } from "../components/PageTopbar";
import { featureAdminAuth, featureAdminConfigured } from "./adminAuth";
import { previewFeatureFlags } from "./previewData";
import type { FeatureConditionType, FeatureFlagDefinition, FeatureFlagRule, FeatureUser } from "./types";

const conditionLabels: Record<FeatureConditionType, string> = {
  users: "指定用户",
  percentage: "百分比",
  authenticated: "已登录用户",
  global: "所有访问者",
};

function newRule(conditionType: FeatureConditionType): FeatureFlagRule {
  return {
    name: conditionLabels[conditionType],
    conditionType,
    serve: true,
    percentage: conditionType === "percentage" ? 1 : null,
    bucketBy: conditionType === "percentage" ? "user" : null,
    bucketSalt: null,
    startsAt: null,
    endsAt: null,
    enabled: true,
    isFallback: false,
    userIds: [],
  };
}

function toLocalInput(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function publishedTime(value: string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

function publishedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "更新时间未知" : new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function FeatureFlagsPage() {
  const previewMode = import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";
  if (previewMode) return <ConfiguredFeatureFlagsPage auth={previewFeatureAdminAuth} preview />;
  if (!featureAdminConfigured || !featureAdminAuth) {
    return (
      <>
        <PageTopbar eyebrow="RUNTIME CONTROL / 运行控制" title="功能开关" description="按顺序控制功能对哪些读者开放。" />
        <main className="feature-empty"><strong>管理登录尚未配置</strong><p>请在仓库根目录配置 Supabase 浏览器端公开值后重新启动管理台。</p></main>
      </>
    );
  }
  return <ConfiguredFeatureFlagsPage auth={featureAdminAuth} />;
}

type FeatureAdminAuth = NonNullable<typeof featureAdminAuth>;

const previewFeatureAdminAuth = {
  client: {
    rpc: async (name: string) => {
      if (name === "get_my_feature_flag_admin_role") return { data: "viewer", error: null };
      if (name === "admin_list_feature_flags") return { data: previewFeatureFlags, error: null };
      return { data: [], error: null };
    },
  },
  startAuthSync: () => () => undefined,
  useAuthStore: () => ({
    initialized: true,
    user: { id: "local-preview" },
    busy: false,
    error: null,
    signIn: async () => undefined,
    signOut: async () => undefined,
  }),
} as unknown as FeatureAdminAuth;

function ConfiguredFeatureFlagsPage({ auth, preview = false }: { auth: FeatureAdminAuth; preview?: boolean }) {
  const { initialized, user, busy, error, signIn, signOut } = auth.useAuthStore();
  const [flags, setFlags] = useState<FeatureFlagDefinition[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [draftRules, setDraftRules] = useState<FeatureFlagRule[]>([]);
  const [role, setRole] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => auth.startAuthSync(), [auth]);

  useEffect(() => {
    if (!user) {
      setFlags([]);
      setRole(null);
      return;
    }
    let active = true;
    void Promise.all([
      (auth.client as any).rpc("get_my_feature_flag_admin_role"),
      (auth.client as any).rpc("admin_list_feature_flags"),
    ]).then(([roleResult, flagsResult]) => {
      if (!active) return;
      if (roleResult.error) throw roleResult.error;
      setRole(typeof roleResult.data === "string" ? roleResult.data : null);
      if (flagsResult.error) throw flagsResult.error;
      const next = Array.isArray(flagsResult.data) ? flagsResult.data as FeatureFlagDefinition[] : [];
      setFlags(next);
      setSelectedKey((current) => current || next[0]?.key || "");
      setLoadError("");
    }).catch((reason: unknown) => {
      if (active) setLoadError(reason instanceof Error ? reason.message : "无法读取功能开关");
    });
    return () => { active = false; };
  }, [auth, user]);

  const selected = flags.find((flag) => flag.key === selectedKey);
  const canEdit = role === "editor";
  useEffect(() => {
    setDraftRules(selected ? structuredClone(selected.rules).map((rule) => ({
      ...rule,
      startsAt: toLocalInput(rule.startsAt),
      endsAt: toLocalInput(rule.endsAt),
    })) : []);
    setReason("");
    setNotice("");
  }, [selected]);

  async function submitLogin(event: FormEvent) {
    event.preventDefault();
    try { await signIn(email, password); } catch { /* store exposes the localized error */ }
  }

  function updateRule(index: number, patch: Partial<FeatureFlagRule>) {
    setDraftRules((rules) => rules.map((rule, position) => position === index ? { ...rule, ...patch } : rule));
  }

  function moveRule(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= draftRules.length || draftRules[index]?.isFallback || draftRules[target]?.isFallback) return;
    setDraftRules((rules) => {
      const next = [...rules];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  function addRule(conditionType: FeatureConditionType) {
    setDraftRules((rules) => {
      const fallbackIndex = rules.findIndex((rule) => rule.isFallback);
      const index = fallbackIndex < 0 ? rules.length : fallbackIndex;
      return [...rules.slice(0, index), newRule(conditionType), ...rules.slice(index)];
    });
  }

  async function publish() {
    if (!selected || reason.trim().length < 3 || role !== "editor") return;
    setSaving(true);
    setNotice("");
    setLoadError("");
    const rules = draftRules.map((rule) => ({
      ...rule,
      percentage: rule.conditionType === "percentage" ? Math.round(rule.percentage || 1) : null,
      bucketBy: rule.conditionType === "percentage" ? rule.bucketBy || "user" : null,
      startsAt: publishedTime(rule.startsAt),
      endsAt: publishedTime(rule.endsAt),
    }));
    try {
      const { data, error } = await (auth.client as any).rpc("admin_publish_feature_flag", {
        p_key: selected.key,
        p_rules: rules,
        p_expected_revision: selected.revision,
        p_reason: reason.trim(),
        p_request_id: crypto.randomUUID(),
      });
      if (error) throw error;
      const updated = data as FeatureFlagDefinition;
      setFlags((items) => items.map((item) => item.key === updated.key ? updated : item));
      setNotice(`已发布 revision ${updated.revision}`);
      setReason("");
    } catch (reason: unknown) {
      setLoadError(reason instanceof Error ? reason.message : "发布失败");
    } finally {
      setSaving(false);
    }
  }

  if (!initialized) return <main className="feature-empty">正在确认管理身份…</main>;
  if (!user) {
    return (
      <>
        <PageTopbar eyebrow="RUNTIME CONTROL / 运行控制" title="功能开关" description="登录管理员账号后编辑运行时规则。" />
        <form className="feature-login" onSubmit={submitLogin}>
          <label>邮箱<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
          <label>密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
          {error && <p role="alert">{error}</p>}
          <button className="primary-button" type="submit" disabled={busy}>{busy ? "登录中…" : "登录管理台"}</button>
        </form>
      </>
    );
  }

  if (loadError && !role) {
    return <><PageTopbar eyebrow="RUNTIME CONTROL / 运行控制" title="功能开关" /><main className="feature-empty"><strong>当前账号没有管理权限</strong><p>{loadError}</p><button className="secondary-button" type="button" onClick={() => void signOut()}>退出账号</button></main></>;
  }

  return (
    <>
      <PageTopbar
        eyebrow="RUNTIME CONTROL / 运行控制"
        title="功能开关"
        description={preview ? "本地只读预览。规则按从上到下的顺序执行，命中第一条后立即停止。" : "规则按从上到下的顺序执行，命中第一条后立即停止。"}
        aside={<span className="local-badge"><i />{preview ? "本地预览" : role === "editor" ? "可发布" : "只读"}</span>}
      />
      <main className="feature-workspace">
        <aside className="feature-index" aria-label="功能开关列表">
          {flags.map((flag) => (
            <button key={flag.key} type="button" className={flag.key === selectedKey ? "active" : ""} onClick={() => setSelectedKey(flag.key)}>
              <b>{flag.key}</b><span>{flag.rules.length} 条规则 · r{flag.revision}</span>
            </button>
          ))}
        </aside>
        {selected && (
          <section className="feature-editor">
            <header><div><p className="eyebrow">{selected.key}</p><h2>{selected.description}</h2></div><div className="feature-revision" title={selected.updatedBy ? `修改人 ${selected.updatedBy}` : "系统初始配置"}><b>revision {selected.revision}</b><span>{publishedAt(selected.updatedAt)}</span></div></header>
            <div className="rule-add-bar">
              <span>添加规则</span>
              {(["users", "percentage", "authenticated", "global"] as const).map((kind) => <button key={kind} type="button" disabled={!canEdit} onClick={() => addRule(kind)}>+ {conditionLabels[kind]}</button>)}
            </div>
            <div className="rule-track">
              {draftRules.map((rule, index) => (
                <RuleCard
                  key={rule.id || `${rule.conditionType}-${index}`}
                  index={index}
                  rule={rule}
                  onChange={(patch) => updateRule(index, patch)}
                  onMove={(direction) => moveRule(index, direction)}
                  onDelete={() => setDraftRules((rules) => rules.filter((_, position) => position !== index))}
                  client={auth.client as any}
                  editable={canEdit}
                />
              ))}
            </div>
            <footer className="feature-publish">
              <label>发布原因<input value={reason} disabled={!canEdit} onChange={(event) => setReason(event.target.value)} placeholder="说明为什么修改这组规则" /></label>
              <button className="primary-button" type="button" disabled={saving || role !== "editor" || reason.trim().length < 3} onClick={() => void publish()}>{saving ? "发布中…" : "发布规则"}</button>
              {notice && <p role="status">{notice}</p>}
              {loadError && <p className="content-error" role="alert">{loadError}</p>}
            </footer>
          </section>
        )}
      </main>
    </>
  );
}

function RuleCard({ index, rule, onChange, onMove, onDelete, client, editable }: {
  index: number;
  rule: FeatureFlagRule;
  onChange: (patch: Partial<FeatureFlagRule>) => void;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
  client: { rpc: (name: string, args?: unknown) => Promise<{ data: unknown; error: unknown }> };
  editable: boolean;
}) {
  const [userQuery, setUserQuery] = useState("");
  const [userResults, setUserResults] = useState<FeatureUser[]>([]);
  const summary = useMemo(() => rule.conditionType === "percentage" ? `${rule.percentage || 1}% · ${rule.bucketBy === "visitor" ? "访问者" : "登录用户"}` : conditionLabels[rule.conditionType], [rule]);

  async function searchUsers() {
    const { data, error } = await client.rpc("admin_search_feature_users", { p_query: userQuery.trim() });
    if (!error) setUserResults(Array.isArray(data) ? data as FeatureUser[] : []);
  }

  return (
    <article className={`rule-card${rule.enabled ? "" : " paused"}${rule.isFallback ? " fallback" : ""}`}>
      <div className="rule-order"><b>{String(index + 1).padStart(2, "0")}</b><i /></div>
      <div className="rule-body">
        <header>
          <input className="rule-name" value={rule.name} disabled={!editable} onChange={(event) => onChange({ name: event.target.value })} aria-label={`规则 ${index + 1} 名称`} />
          <span>{summary}</span>
          <button type="button" disabled={!editable} className={`rule-result ${rule.serve ? "on" : "off"}`} onClick={() => onChange({ serve: !rule.serve })}>{rule.serve ? "ON" : "OFF"}</button>
        </header>
        <div className="rule-fields">
          <label>条件<select value={rule.conditionType} disabled={!editable || rule.isFallback} onChange={(event) => {
            const conditionType = event.target.value as FeatureConditionType;
            onChange({ conditionType, percentage: conditionType === "percentage" ? 1 : null, bucketBy: conditionType === "percentage" ? "user" : null, bucketSalt: null, userIds: [] });
          }}>{Object.entries(conditionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {rule.conditionType === "percentage" && <><label>比例<input type="number" min="1" max="100" step="1" value={rule.percentage || 1} disabled={!editable} onChange={(event) => onChange({ percentage: Math.max(1, Math.min(100, Math.round(Number(event.target.value)))) })} /></label><label>分桶对象<select value={rule.bucketBy || "user"} disabled={!editable} onChange={(event) => onChange({ bucketBy: event.target.value as "user" | "visitor" })}><option value="user">登录用户</option><option value="visitor">匿名访问者</option></select></label></>}
          <label>开始时间<input type="datetime-local" value={rule.startsAt || ""} onChange={(event) => onChange({ startsAt: event.target.value || null })} disabled={!editable || rule.isFallback} /></label>
          <label>结束时间<input type="datetime-local" value={rule.endsAt || ""} onChange={(event) => onChange({ endsAt: event.target.value || null })} disabled={!editable || rule.isFallback} /></label>
        </div>
        {rule.conditionType === "users" && <div className="rule-users"><div><input value={userQuery} onChange={(event) => setUserQuery(event.target.value)} placeholder="搜索读者代号、UUID 或邮箱" /><button type="button" onClick={() => void searchUsers()}>搜索</button></div>{userResults.map((candidate) => <button key={candidate.user_id} type="button" disabled={!editable} onClick={() => onChange({ userIds: [...new Set([...rule.userIds, candidate.user_id])] })}>+ {candidate.display_name || candidate.email || candidate.user_id}</button>)}<ul>{rule.userIds.map((userId) => <li key={userId}><code>{userId}</code><button type="button" disabled={!editable} onClick={() => onChange({ userIds: rule.userIds.filter((id) => id !== userId) })}>移除</button></li>)}</ul></div>}
        <footer>
          <label><input type="checkbox" checked={rule.enabled} disabled={!editable || rule.isFallback} onChange={(event) => onChange({ enabled: event.target.checked })} />启用规则</label>
          {!rule.isFallback && <><button type="button" disabled={!editable} onClick={() => onMove(-1)} aria-label={`上移规则 ${index + 1}`}>↑</button><button type="button" disabled={!editable} onClick={() => onMove(1)} aria-label={`下移规则 ${index + 1}`}>↓</button><button type="button" disabled={!editable} onClick={onDelete}>删除</button></>}
          {rule.isFallback && <span>最终默认规则 · 固定在末尾</span>}
        </footer>
      </div>
    </article>
  );
}
