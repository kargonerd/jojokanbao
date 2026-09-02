import { useEffect, useState } from "react";
import { OperationDialog } from "../components/OperationDialog";
import { PageTopbar } from "../components/PageTopbar";
import { agentAdminApi, type AgentCredentialStatus } from "./api";

function readableTime(value: string | null): string {
  if (!value) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function AgentAdminPage() {
  const [status, setStatus] = useState<AgentCredentialStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [pushing, setPushing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    setLoading(true);
    try {
      setStatus(await agentAdminApi.status());
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取 Agent 管理状态");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function pushCredential() {
    setConfirming(false);
    setPushing(true);
    setError("");
    setNotice("");
    try {
      const result = await agentAdminApi.pushCredential();
      setNotice(`已更新 ${result.targetOrigin} · ${readableTime(result.pushedAt)}`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Agent 凭据更新失败");
    } finally {
      setPushing(false);
    }
  }

  return (
    <>
      <PageTopbar
        eyebrow="AGENT OPERATIONS / AGENT 运维"
        title="Agent 管理"
        description="管理 Agent 使用的专用 Codex OAuth 凭据。密钥与凭据只在本机服务和部署端之间传输。"
        aside={
          <span className={`agent-state-badge ${status?.canPush ? "ready" : "blocked"}`}>
            <i />
            {loading ? "正在检查" : status?.canPush ? "本机就绪" : "需要处理"}
          </span>
        }
      />
      <main className="agent-admin">
        <section className="agent-transfer" aria-label="Agent 凭据传输路径">
          <article>
            <span className="agent-transfer-code">LOCAL / 01</span>
            <h2>Codex OAuth</h2>
            <p>{status?.credential.sourceLabel || "正在检查本机凭据"}</p>
            <code>{status?.credential.pathHint || "—"}</code>
            <b className={status?.credential.available ? "ok" : "bad"}>
              {status?.credential.available ? "凭据可用" : "未找到凭据"}
            </b>
          </article>
          <div className="agent-transfer-gate" aria-hidden="true">
            <span>JOJO</span>
            <b>OPERATOR</b>
            <i>→</i>
          </div>
          <article>
            <span className="agent-transfer-code">REMOTE / 02</span>
            <h2>已部署 Agent</h2>
            <p>只写入 openai-codex，不返回已有凭据。</p>
            <code>{status?.targetOrigin || "—"}</code>
            <b className={status?.serviceConfigured ? "ok" : "bad"}>
              {status?.serviceConfigured ? "服务地址有效" : "服务地址未配置"}
            </b>
          </article>
        </section>

        <section className="agent-ledger">
          <header>
            <div>
              <p className="eyebrow">CREDENTIAL MANIFEST</p>
              <h2>凭据交接单</h2>
            </div>
            <button className="secondary-button" type="button" disabled={loading} onClick={() => void load()}>
              重新检查
            </button>
          </header>
          <dl>
            <div><dt>Operator Token</dt><dd><i className={status?.operatorConfigured ? "ok" : "bad"} />{status?.operatorConfigured ? "本机已加载" : "未配置"}</dd></div>
            <div><dt>凭据类型</dt><dd>{status?.credential.type || "—"}</dd></div>
            <div><dt>凭据有效期</dt><dd className={status?.credential.expired ? "bad-text" : ""}>{status?.credential.expiresAt ? readableTime(status.credential.expiresAt) : "—"}</dd></div>
            <div><dt>写入范围</dt><dd><code>agent / openai-codex</code></dd></div>
          </dl>

          {!loading && status && !status.credential.available && (
            <div className="agent-guidance">
              <strong>需要先准备 Agent 专用 Codex OAuth</strong>
              <p>{status.credential.error}</p>
              <code>pnpm --filter @jojo/agent auth:codex</code>
            </div>
          )}
          {!loading && status?.credential.expired && (
            <div className="agent-guidance">
              <strong>Agent 专用凭据已经过期</strong>
              <p>重新完成 Codex 登录后再更新 Agent。</p>
            </div>
          )}
          {error && <p className="content-error" role="alert">{error}</p>}
          {notice && <p className="agent-success" role="status">{notice}</p>}

          <footer>
            <p>更新会替换部署端当前的 Codex OAuth 凭据，不影响 Feature Flag 配置。</p>
            <button
              className="primary-button"
              type="button"
              disabled={!status?.canPush || pushing || status.credential.expired}
              onClick={() => setConfirming(true)}
            >
              {pushing ? "正在更新…" : "更新 Agent 凭据"}
            </button>
          </footer>
        </section>
      </main>

      <OperationDialog
        open={confirming}
        kicker="AGENT CREDENTIAL UPDATE"
        title="确认更新 Agent 凭据"
        message="Agent 专用 Codex OAuth 将通过受保护接口写入部署端，并替换当前凭据。上传会消费本地 rotating refresh token；如需继续在本地运行 Agent，请重新登录。界面不会读取或展示凭据内容。"
        details={[
          { label: "目标", value: status?.targetOrigin || "—" },
          { label: "范围", value: "agent / openai-codex" },
          { label: "认证", value: "JOJO_OPERATOR_TOKEN" },
        ]}
        confirmLabel="确认更新"
        cancelLabel="取消"
        onConfirm={() => void pushCredential()}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}
