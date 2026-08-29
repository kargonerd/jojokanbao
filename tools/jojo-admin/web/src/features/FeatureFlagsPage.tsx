import { useEffect, useMemo, useState } from "react";
import { PageTopbar } from "../components/PageTopbar";
import { featureFlagApi } from "./api";
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

function editableRules(rules: FeatureFlagRule[]): FeatureFlagRule[] {
  return structuredClone(rules).map((rule) => ({
    ...rule,
    startsAt: toLocalInput(rule.startsAt),
    endsAt: toLocalInput(rule.endsAt),
  }));
}

function editableConfig(config: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return structuredClone(config ?? {});
}

function annotationThreshold(config: Record<string, unknown>): number {
  const value = config.publicMarkThreshold;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100 ? value : 2;
}

export function FeatureFlagsPage() {
  const [flags, setFlags] = useState<FeatureFlagDefinition[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [draftRules, setDraftRules] = useState<FeatureFlagRule[]>([]);
  const [draftConfig, setDraftConfig] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    void featureFlagApi.list().then((next) => {
      if (!active) return;
      const initial = next[0];
      setFlags(next);
      setSelectedKey(initial?.key ?? "");
      setDraftRules(initial ? editableRules(initial.rules) : []);
      setDraftConfig(initial ? editableConfig(initial.config) : {});
      setLoadError("");
    }).catch((error: unknown) => {
      if (active) setLoadError(error instanceof Error ? error.message : "无法读取功能开关");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const selected = flags.find((flag) => flag.key === selectedKey);

  function selectFlag(flag: FeatureFlagDefinition) {
    setSelectedKey(flag.key);
    setDraftRules(editableRules(flag.rules));
    setDraftConfig(editableConfig(flag.config));
    setReason("");
    setNotice("");
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
    if (!selected || reason.trim().length < 3) return;
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
      const updated = await featureFlagApi.publish({
        key: selected.key,
        rules,
        config: draftConfig,
        expectedRevision: selected.revision,
        reason: reason.trim(),
        requestId: crypto.randomUUID(),
      });
      setFlags((items) => items.map((item) => item.key === updated.key ? updated : item));
      setDraftRules(editableRules(updated.rules));
      setDraftConfig(editableConfig(updated.config));
      setNotice(`已发布 revision ${updated.revision}`);
      setReason("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "发布失败");
    } finally {
      setSaving(false);
    }
  }

  async function rollback(targetRevision: number) {
    if (!selected || targetRevision === selected.revision) return;
    setSaving(true);
    setNotice("");
    setLoadError("");
    try {
      const updated = await featureFlagApi.rollback({
        key: selected.key,
        targetRevision,
        expectedRevision: selected.revision,
        requestId: crypto.randomUUID(),
      });
      setFlags((items) => items.map((item) => item.key === updated.key ? updated : item));
      setDraftRules(editableRules(updated.rules));
      setDraftConfig(editableConfig(updated.config));
      setReason("");
      setNotice(`已回滚到 revision ${targetRevision}，当前为 revision ${updated.revision}`);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "回滚失败");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <main className="feature-empty">正在读取功能开关…</main>;
  }
  if (loadError && !flags.length) {
    return (
      <>
        <PageTopbar eyebrow="RUNTIME CONTROL / 运行控制" title="功能开关" description="本机通过 JOJO Operator 管理运行时规则。" />
        <main className="feature-empty"><strong>无法连接功能开关</strong><p>{loadError}</p><p>确认本地 API 已启动，并在仓库 `.env` 配置现有的 JOJO_OPERATOR_TOKEN。</p></main>
      </>
    );
  }

  return (
    <>
      <PageTopbar
        eyebrow="RUNTIME CONTROL / 运行控制"
        title="功能开关"
        description="规则从上到下执行，命中第一条后立即停止。"
        aside={<span className="local-badge"><i />本机 Operator</span>}
      />
      <main className="feature-workspace">
        <aside className="feature-index" aria-label="功能开关列表">
          {flags.map((flag) => (
            <button key={flag.key} type="button" className={flag.key === selectedKey ? "active" : ""} onClick={() => selectFlag(flag)}>
              <b>{flag.key}</b><span>{flag.rules.length} 条规则 · r{flag.revision}</span>
            </button>
          ))}
        </aside>
        {selected && (
          <section className="feature-editor">
            <header><div><p className="eyebrow">{selected.key}</p><h2>{selected.description}</h2></div><div className="feature-revision" title="由本机 Operator 修改"><b>revision {selected.revision}</b><span>{publishedAt(selected.updatedAt)}</span></div></header>
            {selected.key === "reader.annotations" && (
              <section className="feature-config-strip" aria-labelledby="annotation-threshold-title">
                <div>
                  <p className="eyebrow">PUBLIC DISPLAY / 公开展示</p>
                  <h3 id="annotation-threshold-title">划线公开阈值</h3>
                  <span>达到该人数，或存在至少一条公开想法时，向其他读者展示。</span>
                </div>
                <label>
                  <span>读者人数</span>
                  <div>
                    <input
                      aria-label="划线公开阈值"
                      type="number"
                      min="1"
                      max="100"
                      step="1"
                      value={annotationThreshold(draftConfig)}
                      onChange={(event) => {
                        const publicMarkThreshold = Math.max(1, Math.min(100, Math.round(Number(event.target.value) || 1)));
                        setDraftConfig((current) => ({ ...current, publicMarkThreshold }));
                      }}
                    />
                    <b>人</b>
                  </div>
                </label>
              </section>
            )}
            <section className="feature-history" aria-label="修改记录">
              <header><div><b>修改记录</b><span>回滚会恢复当时的规则和配置，并生成新的 revision。</span></div><small>{selected.history.length} 个版本</small></header>
              <ol>
                {[...selected.history].reverse().map((entry) => {
                  const current = entry.revision === selected.revision;
                  return (
                    <li key={`${entry.revision}-${entry.requestId || "seed"}`} className={current ? "current" : ""}>
                      <code>r{entry.revision}</code>
                      <div><b>{entry.reason}</b><span>{publishedAt(entry.updatedAt)}</span></div>
                      {current
                        ? <em>当前版本</em>
                        : <button type="button" disabled={saving} onClick={() => void rollback(entry.revision)}>回滚到 revision {entry.revision}</button>}
                    </li>
                  );
                })}
              </ol>
            </section>
            <div className="rule-add-bar">
              <span>添加规则</span>
              {(["users", "percentage", "authenticated", "global"] as const).map((kind) => <button key={kind} type="button" onClick={() => addRule(kind)}>+ {conditionLabels[kind]}</button>)}
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
                />
              ))}
            </div>
            <footer className="feature-publish">
              <label>发布原因<input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明为什么修改这组规则" /></label>
              <button className="primary-button" type="button" disabled={saving || reason.trim().length < 3} onClick={() => void publish()}>{saving ? "发布中…" : "发布更改"}</button>
              {notice && <p role="status">{notice}</p>}
              {loadError && <p className="content-error" role="alert">{loadError}</p>}
            </footer>
          </section>
        )}
      </main>
    </>
  );
}

function RuleCard({ index, rule, onChange, onMove, onDelete }: {
  index: number;
  rule: FeatureFlagRule;
  onChange: (patch: Partial<FeatureFlagRule>) => void;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
}) {
  const [userQuery, setUserQuery] = useState("");
  const [userResults, setUserResults] = useState<FeatureUser[]>([]);
  const summary = useMemo(() => rule.conditionType === "percentage" ? `${rule.percentage || 1}% · ${rule.bucketBy === "visitor" ? "访问者" : "登录用户"}` : conditionLabels[rule.conditionType], [rule]);

  async function searchUsers() {
    try {
      setUserResults(await featureFlagApi.searchUsers(userQuery.trim()));
    } catch {
      setUserResults([]);
    }
  }

  return (
    <article className={`rule-card${rule.enabled ? "" : " paused"}${rule.isFallback ? " fallback" : ""}`}>
      <div className="rule-order"><b>{String(index + 1).padStart(2, "0")}</b><i /></div>
      <div className="rule-body">
        <header>
          <input className="rule-name" value={rule.name} onChange={(event) => onChange({ name: event.target.value })} aria-label={`规则 ${index + 1} 名称`} />
          <span>{summary}</span>
          <button type="button" className={`rule-result ${rule.serve ? "on" : "off"}`} onClick={() => onChange({ serve: !rule.serve })}>{rule.serve ? "ON" : "OFF"}</button>
        </header>
        <div className="rule-fields">
          <label>条件<select value={rule.conditionType} disabled={rule.isFallback} onChange={(event) => {
            const conditionType = event.target.value as FeatureConditionType;
            onChange({ conditionType, percentage: conditionType === "percentage" ? 1 : null, bucketBy: conditionType === "percentage" ? "user" : null, bucketSalt: null, userIds: [] });
          }}>{Object.entries(conditionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {rule.conditionType === "percentage" && <><label>比例<input type="number" min="1" max="100" step="1" value={rule.percentage || 1} onChange={(event) => onChange({ percentage: Math.max(1, Math.min(100, Math.round(Number(event.target.value)))) })} /></label><label>分桶对象<select value={rule.bucketBy || "user"} onChange={(event) => onChange({ bucketBy: event.target.value as "user" | "visitor" })}><option value="user">登录用户</option><option value="visitor">匿名访问者</option></select></label></>}
          <label>开始时间<input type="datetime-local" value={rule.startsAt || ""} onChange={(event) => onChange({ startsAt: event.target.value || null })} disabled={rule.isFallback} /></label>
          <label>结束时间<input type="datetime-local" value={rule.endsAt || ""} onChange={(event) => onChange({ endsAt: event.target.value || null })} disabled={rule.isFallback} /></label>
        </div>
        {rule.conditionType === "users" && <div className="rule-users"><div><input value={userQuery} onChange={(event) => setUserQuery(event.target.value)} placeholder="搜索读者代号、UUID 或邮箱" /><button type="button" onClick={() => void searchUsers()}>搜索</button></div>{userResults.map((candidate) => <button key={candidate.user_id} type="button" onClick={() => onChange({ userIds: [...new Set([...rule.userIds, candidate.user_id])] })}>+ {candidate.display_name || candidate.email || candidate.user_id}</button>)}<ul>{rule.userIds.map((userId) => <li key={userId}><code>{userId}</code><button type="button" onClick={() => onChange({ userIds: rule.userIds.filter((id) => id !== userId) })}>移除</button></li>)}</ul></div>}
        <footer>
          <label><input type="checkbox" checked={rule.enabled} disabled={rule.isFallback} onChange={(event) => onChange({ enabled: event.target.checked })} />启用规则</label>
          {!rule.isFallback && <><button type="button" onClick={() => onMove(-1)} aria-label={`上移规则 ${index + 1}`}>↑</button><button type="button" onClick={() => onMove(1)} aria-label={`下移规则 ${index + 1}`}>↓</button><button type="button" onClick={onDelete}>删除</button></>}
          {rule.isFallback && <span>最终默认规则 · 固定在末尾</span>}
        </footer>
      </div>
    </article>
  );
}
