import { useEffect, useMemo, useState } from "react";
import { Button, Field, LoadingSpinner, TextInput } from "@jojo/ui";
import { PageTopbar } from "../components/PageTopbar";
import { OperationDialog } from "../components/OperationDialog";
import {
  apiGet,
  apiPost,
  watchProgress,
  type FileMapping,
  type Progress,
  type Publication,
  type StagingResult,
} from "../lib/api";
import { usePdfWorkflow } from "../stores/pdfWorkflowStore";

type Notice = { mode: "success" | "error"; title: string; message: string };
type ScanResponse = { success: boolean; mapping: FileMapping[]; ai_prompt?: string };
type TaskResponse = { success: boolean; task_id: string; staging_id?: string };

const steps = [
  ["publication", "01", "选择报刊"],
  ["folder", "02", "选择来源"],
  ["mapping", "03", "校对文件"],
  ["processing", "04", "处理发布"],
  ["complete", "05", "完成"],
] as const;

export function PdfDataPage() {
  const workflow = usePdfWorkflow();
  const [publications, setPublications] = useState<Publication[]>([]);
  const [busy, setBusy] = useState(false);
  const [pendingPublicationCodes, setPendingPublicationCodes] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice>();
  const [showCreate, setShowCreate] = useState(false);
  const [rule, setRule] = useState("");
  const [vuePreview, setVuePreview] = useState<Record<string, unknown>>();
  const [newPublication, setNewPublication] = useState({
    code: "", name: "", type: "newspaper", description: "", default_date: "",
  });

  useEffect(() => {
    apiGet<{ success: boolean; publications: Publication[] }>("/api/publications")
      .then((data) => setPublications(data.publications))
      .catch((error: Error) => setNotice({ mode: "error", title: "报刊加载失败", message: error.message }));
  }, []);

  useEffect(() => {
    if (!workflow.taskId) return;
    return watchProgress(
      workflow.taskId,
      (progress) => {
        workflow.setProgress(progress);
        if (progress.status === "completed" && progress.task_type !== "commit") {
          const result = progress.result as StagingResult | undefined;
          if (result?.staging_id) workflow.setStaging(result);
        }
        if (progress.status === "completed" && progress.task_type === "commit") {
          workflow.setStep("complete");
          setNotice({ mode: "success", title: "发布完成", message: "PDF 文件与报刊配置已经提交。" });
        }
        if (progress.status === "failed") {
          setNotice({ mode: "error", title: "处理失败", message: progress.error || "后台任务未完成。" });
        }
      },
      () => setNotice({ mode: "error", title: "进度连接中断", message: "请检查服务状态后重试。" }),
    );
  }, [workflow.taskId]);

  const successMapping = useMemo(() => workflow.mapping.filter((item) => item.success), [workflow.mapping]);
  const failedMapping = useMemo(() => workflow.mapping.filter((item) => !item.success), [workflow.mapping]);
  const progressValue = calculateProgress(workflow.progress);

  async function createPublication() {
    setBusy(true);
    try {
      const data = await apiPost<{ success: boolean; publication: Publication }>("/api/publications", newPublication);
      setPublications((items) => [...items, data.publication]);
      setPendingPublicationCodes((codes) => [...codes, data.publication.code]);
      workflow.setPublication(data.publication);
      setShowCreate(false);
    } catch (error) {
      setNotice({ mode: "error", title: "创建失败", message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function browse() {
    setBusy(true);
    try {
      const data = await apiPost<{ success: boolean; path: string }>("/api/browse-folder");
      workflow.setSourceDir(data.path);
    } catch (error) {
      setNotice({ mode: "error", title: "选择失败", message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function scan() {
    if (!workflow.publication || !workflow.sourceDir) return;
    setBusy(true);
    try {
      const data = await apiPost<ScanResponse>("/api/scan-files", {
        source_dir: workflow.sourceDir,
        pub_code: workflow.publication.code,
        pub_type: workflow.publication.type,
        pub_name: workflow.publication.name,
      });
      workflow.setScan(data.mapping, data.ai_prompt);
    } catch (error) {
      setNotice({ mode: "error", title: "扫描失败", message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function applyRule() {
    if (!workflow.publication) return;
    setBusy(true);
    try {
      const parsed = JSON.parse(rule) as Record<string, unknown>;
      const data = await apiPost<{ success: boolean; results: FileMapping[] }>("/api/apply-custom-rule", {
        rule: parsed,
        failed_files: failedMapping.map((item) => item.original),
        pub_type: workflow.publication.type,
      });
      const replacements = new Map(data.results.map((item) => [item.original, item]));
      workflow.setScan(workflow.mapping.map((item) => replacements.get(item.original) || item), workflow.aiPrompt);
      await apiPost("/api/save-custom-rule", { pub_code: workflow.publication.code, rule: parsed });
    } catch (error) {
      setNotice({ mode: "error", title: "规则应用失败", message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function stage() {
    if (!workflow.publication) return;
    setBusy(true);
    try {
      const data = await apiPost<TaskResponse>("/api/start-staging", {
        source_dir: workflow.sourceDir,
        pub_code: workflow.publication.code,
        mapping: workflow.mapping,
        new_pub_config: pendingPublicationCodes.includes(workflow.publication.code) ? workflow.publication : null,
      });
      workflow.setTask(data.task_id, data.staging_id || "");
    } catch (error) {
      setNotice({ mode: "error", title: "预处理启动失败", message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!workflow.publication || !workflow.stagingId) return;
    setBusy(true);
    try {
      const data = await apiPost<TaskResponse>("/api/commit-files", {
        staging_id: workflow.stagingId,
        pub_code: workflow.publication.code,
        new_pub_config: pendingPublicationCodes.includes(workflow.publication.code) ? workflow.publication : null,
      });
      workflow.setTask(data.task_id, workflow.stagingId);
    } catch (error) {
      setNotice({ mode: "error", title: "提交失败", message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function generateVue() {
    if (!workflow.publication) return;
    setBusy(true);
    try {
      const data = await apiPost<Record<string, unknown> & { success: boolean }>("/api/generate-vue-preview", {
        pub_code: workflow.publication.code,
      });
      setVuePreview(data);
    } catch (error) {
      setNotice({ mode: "error", title: "代码预览失败", message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function applyVue() {
    if (!workflow.publication || !vuePreview?.new_code) return;
    setBusy(true);
    try {
      await apiPost("/api/apply-vue-changes", {
        pub_code: workflow.publication.code,
        new_vue_code: vuePreview.new_code,
      });
      setNotice({ mode: "success", title: "页面代码已更新", message: "Vue 报刊数据文件已应用。" });
    } catch (error) {
      setNotice({ mode: "error", title: "应用失败", message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <PageTopbar eyebrow="DATA PIPELINE / PDF" title="PDF 数据管理" description="从原始报刊文件到线上数据，一条可检查、可回退的发布流程。" />
      <div className="step-rail">
        {steps.map(([key, number, label]) => (
          <button className={workflow.step === key ? "active" : ""} key={key} onClick={() => workflow.setStep(key)}>
            <b>{number}</b><span>{label}</span>
          </button>
        ))}
      </div>

      <section className="workspace-panel">
        {workflow.step === "publication" && (
          <>
            <SectionHeading number="01" title="选择报刊" note="既有报刊直接进入导入；新刊只在最终提交时写入配置。" />
            <div className="publication-grid">
              {publications.map((publication) => (
                <button className="publication-card" key={publication.code} onClick={() => workflow.setPublication(publication)}>
                  <span>{publication.type === "newspaper" ? "报纸" : "期刊"}</span>
                  <b>{publication.name}</b><small>{publication.code}</small>
                </button>
              ))}
              <button className="publication-card create" onClick={() => setShowCreate(true)}><b>＋ 新建报刊</b><small>配置将在发布时落盘</small></button>
            </div>
          </>
        )}

        {workflow.step === "folder" && (
          <>
            <SectionHeading number="02" title="选择 PDF 来源" note={`${workflow.publication?.name || "未选择报刊"} · 支持递归扫描子目录`} />
            <div className="source-picker">
              <Field label="本机目录"><TextInput value={workflow.sourceDir} onChange={(event) => workflow.setSourceDir(event.target.value)} placeholder="C:/data/newspapers/..." /></Field>
              <Button variant="outline" onClick={browse}>浏览文件夹</Button>
              <Button disabled={!workflow.sourceDir || busy} onClick={scan}>{busy ? "扫描中…" : "扫描 PDF"}</Button>
            </div>
          </>
        )}

        {workflow.step === "mapping" && (
          <>
            <SectionHeading number="03" title="校对文件名映射" note={`${successMapping.length} 个可处理，${failedMapping.length} 个需修正`} />
            <div className="mapping-table">
              <div className="table-head"><span>原始文件</span><span>目标文件名</span><span>状态</span></div>
              {workflow.mapping.map((item) => (
                <div className="table-row" key={`${item.rel_path}-${item.original}`}>
                  <span>{item.rel_path || item.original}</span><span>{item.renamed || "—"}</span>
                  <span className={item.success ? "status-ok" : "status-error"}>{item.success ? "可处理" : item.error || "未匹配"}</span>
                </div>
              ))}
            </div>
            {failedMapping.length > 0 && (
              <div className="rule-workbench">
                <div><h3>规则修正台</h3><p>把下方提示交给模型，将返回的 JSON 规则贴回这里测试。</p></div>
                {workflow.aiPrompt && <details><summary>查看 AI 提示词</summary><pre>{workflow.aiPrompt}</pre></details>}
                <textarea value={rule} onChange={(event) => setRule(event.target.value)} placeholder={'{"pattern":"…","replacement":"…"}'} />
                <Button disabled={!rule || busy} variant="outline" onClick={applyRule}>测试并应用规则</Button>
              </div>
            )}
            <div className="panel-actions"><Button variant="outline" onClick={() => workflow.setStep("folder")}>返回</Button><Button disabled={!successMapping.length || busy} onClick={stage}>开始预处理</Button></div>
          </>
        )}

        {workflow.step === "processing" && (
          <>
            <SectionHeading number="04" title={workflow.staging ? "核对预处理结果" : "正在处理"} note={workflow.progress?.unit_label || "PDF 文件与页面"} />
            <div className="progress-block"><div><span style={{ width: `${progressValue}%` }} /></div><b>{progressValue}%</b><p>{progressLabel(workflow.progress)}</p></div>
            {workflow.staging && (
              <>
                <ResultSummary staging={workflow.staging} />
                <div className="panel-actions"><Button variant="outline" onClick={() => workflow.setStep("mapping")}>返回校对</Button><Button disabled={busy} onClick={commit}>确认提交</Button></div>
              </>
            )}
          </>
        )}

        {workflow.step === "complete" && (
          <>
            <SectionHeading number="05" title="数据发布完成" note={`${workflow.publication?.name || ""} 已写入目标存储`} />
            <div className="completion-card"><span>✓</span><div><b>PDF 数据已就绪</b><p>可以继续生成前端报刊数据，或开始下一次导入。</p></div></div>
            <div className="panel-actions"><Button variant="outline" onClick={generateVue}>{busy ? "生成中…" : "生成页面代码预览"}</Button><Button onClick={workflow.reset}>导入另一批文件</Button></div>
            {vuePreview && <div className="diff-preview"><h3>{String(vuePreview.vue_filename || "代码变更")}</h3><div dangerouslySetInnerHTML={{ __html: String(vuePreview.diff_html || "没有可显示的差异") }} /><Button disabled={!vuePreview.new_code || busy} onClick={applyVue}>应用页面代码</Button></div>}
          </>
        )}
      </section>

      {showCreate && (
        <div className="dialog-backdrop"><div className="create-dialog"><h2>新建报刊</h2><p>这里创建的是待发布配置，只有最终提交后才会进入 config.json。</p>
          <div className="form-grid">
            <Field label="报刊代码"><TextInput value={newPublication.code} onChange={(e) => setNewPublication({ ...newPublication, code: e.target.value.toUpperCase() })} /></Field>
            <Field label="中文名称"><TextInput value={newPublication.name} onChange={(e) => setNewPublication({ ...newPublication, name: e.target.value })} /></Field>
            <Field label="类型"><select value={newPublication.type} onChange={(e) => setNewPublication({ ...newPublication, type: e.target.value })}><option value="newspaper">报纸</option><option value="journal">期刊</option></select></Field>
            <Field label="默认日期"><TextInput value={newPublication.default_date} onChange={(e) => setNewPublication({ ...newPublication, default_date: e.target.value })} /></Field>
          </div>
          <Field label="说明"><TextInput value={newPublication.description} onChange={(e) => setNewPublication({ ...newPublication, description: e.target.value })} /></Field>
          <div className="panel-actions"><Button variant="outline" onClick={() => setShowCreate(false)}>取消</Button><Button disabled={busy || !newPublication.code || !newPublication.name} onClick={createPublication}>创建并继续</Button></div>
        </div></div>
      )}
      {busy && <div className="corner-loading"><LoadingSpinner /> 正在处理</div>}
      {notice && <OperationDialog open kicker={notice.mode === "error" ? "OPERATION FAILED" : "OPERATION COMPLETE"} title={notice.title} message={notice.message} onClose={() => setNotice(undefined)} onConfirm={() => setNotice(undefined)} />}
    </main>
  );
}

function SectionHeading({ number, title, note }: { number: string; title: string; note: string }) {
  return <header className="section-heading"><span>{number}</span><div><h2>{title}</h2><p>{note}</p></div></header>;
}

function ResultSummary({ staging }: { staging: StagingResult }) {
  return <div className="result-summary">
    <article><b>{staging.preview?.length || 0}</b><span>待提交文件</span></article>
    <article><b>{staging.skipped?.length || 0}</b><span>跳过</span></article>
    <article><b>{staging.errors?.length || 0}</b><span>错误</span></article>
  </div>;
}

function calculateProgress(progress?: Progress) {
  if (!progress) return 0;
  if (progress.status === "completed") return 100;
  const done = progress.current_page || progress.completed_files || 0;
  const total = progress.total_pages || progress.total_files || 0;
  return total ? Math.min(99, Math.round(done / total * 100)) : 0;
}

function progressLabel(progress?: Progress) {
  if (!progress) return "正在等待后台任务…";
  if (progress.status === "failed") return progress.error || "任务失败";
  if (progress.status === "completed") return "处理完成，请核对结果";
  return `${progress.completed_files || 0} / ${progress.total_files || 0} ${progress.unit_label || "文件"}`;
}
