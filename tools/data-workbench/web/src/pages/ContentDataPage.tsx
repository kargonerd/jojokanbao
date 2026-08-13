import { useEffect, useMemo, useRef, useState } from "react";
import { PageTopbar } from "../components/PageTopbar";
import { contentApi, type ContentJob, type PublisherStatus } from "../content/api";

export function ContentDataPage() {
  const [sourcePath, setSourcePath] = useState("");
  const [fetchAssets, setFetchAssets] = useState(true);
  const [publicationStatus, setPublicationStatus] = useState<"draft" | "published">("draft");
  const [access, setAccess] = useState<"public" | "authenticated">("public");
  const [job, setJob] = useState<ContentJob>();
  const [publishers, setPublishers] = useState<PublisherStatus>();
  const [targets, setTargets] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([contentApi.status(), contentApi.jobs()]).then(([status, jobs]) => {
      setPublishers(status.publishers);
      setTargets(Object.entries(status.publishers).filter(([, value]) => value.configured).map(([name]) => name));
      setJob(jobs.jobs[0]);
    }).catch((reason: Error) => setError(reason.message));
  }, []);

  useEffect(() => {
    if (!job || !["queued", "building", "publishing"].includes(job.status)) return;
    const timer = window.setInterval(() => {
      contentApi.job(job.jobId).then((result) => setJob(result.job)).catch((reason: Error) => setError(reason.message));
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [job?.jobId, job?.status]);

  const canPublish = job && ["ready", "published", "publish-failed"].includes(job.status);
  const progress = useMemo(() => {
    const current = Number(job?.progress.current || 0);
    const total = Number(job?.progress.total || 0);
    return total ? Math.round(current / total * 100) : job?.status === "ready" || job?.status === "published" ? 100 : 0;
  }, [job]);

  async function browse() {
    setBusy(true); setError("");
    try { setSourcePath((await contentApi.browse()).path); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  async function importPath() {
    setBusy(true); setError("");
    try { setJob((await contentApi.importPaths([sourcePath], fetchAssets, publicationStatus, access)).job); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  async function importFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true); setError("");
    try { setJob((await contentApi.importFiles([...files], fetchAssets, publicationStatus, access)).job); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ""; }
  }

  async function publish() {
    if (!job) return;
    setBusy(true); setError("");
    try { setJob((await contentApi.publish(job.jobId, targets)).job); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  function toggleTarget(name: string) {
    setTargets((current) => current.includes(name) ? current.filter((item) => item !== name) : [...current, name]);
  }

  return <>
    <PageTopbar eyebrow="Content Pipeline / v1" title="书籍与内容" description="微信读书 / EPUB / Kindle → Canonical → Jox / EPUB → B2、ES 与 Hugging Face" />
    <main className="content-workbench">
      <section className="workspace-panel content-import-panel">
        <div className="section-heading"><span>01</span><div><h2>选择本地源数据</h2><p>支持微信读书 JSON、EPUB，以及无 DRM 的 AZW / MOBI / PRC；目录会读取全部支持文件。</p></div></div>
        <div className="content-path-row">
          <label><span>本地文件或目录</span><input placeholder="C:\\path\\to\\weread-exports" value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} /></label>
          <button className="secondary-button" disabled={busy} onClick={browse}>选择目录</button>
          <button className="primary-button" disabled={busy || !sourcePath.trim()} onClick={importPath}>开始处理</button>
        </div>
        <div className="content-options">
          <label><input type="checkbox" checked={fetchAssets} onChange={(event) => setFetchAssets(event.target.checked)} /> 下载封面与正文图片</label>
          <span>或</span>
          <button className="text-button" onClick={() => fileInput.current?.click()}>从浏览器上传电子书</button>
          <input ref={fileInput} hidden type="file" accept="application/json,application/epub+zip,.json,.epub,.azw,.mobi,.prc" multiple onChange={(event) => void importFiles(event.target.files)} />
        </div>
        <div className="content-options">
          <label>发布状态 <select value={publicationStatus} onChange={(event) => setPublicationStatus(event.target.value as "draft" | "published")}><option value="draft">草稿（不在馆藏展示）</option><option value="published">发布</option></select></label>
          <label>阅读门槛 <select value={access} onChange={(event) => setAccess(event.target.value as "public" | "authenticated")}><option value="public">任何人</option><option value="authenticated">仅登录用户（软门槛）</option></select></label>
        </div>
        {error && <p className="content-error">{error}</p>}
      </section>

      {job && <section className="workspace-panel content-job-panel">
        <div className="content-job-head"><div><span className="eyebrow">JOB {job.jobId}</span><h2>{job.message}</h2></div><b className={`job-status status-${job.status}`}>{job.status}</b></div>
        <div className="content-progress"><i style={{ width: `${progress}%` }} /></div>
        {job.report && <>
          <div className="report-grid">
            <Metric label="输入" value={job.report.inputFiles} />
            <Metric label="数据集" value={job.report.datasets} />
            <Metric label="Item" value={job.report.items} />
            <Metric label="章节" value={job.report.chapters} />
            <Metric label="检索片段" value={job.report.searchDocuments} />
            <Metric label="资源" value={job.report.assets} />
          </div>
          {job.report.diagnostics.length > 0 && <details className="diagnostics"><summary>{job.report.diagnostics.length} 条导入说明</summary>{job.report.diagnostics.map((item, index) => <p key={`${item.code}-${index}`}><b>{item.code}</b> {item.message}</p>)}</details>}
        </>}
        <details className="job-log"><summary>处理日志</summary><pre>{job.logs.join("\n")}</pre></details>
      </section>}

      {canPublish && publishers && <section className="workspace-panel content-publish-panel">
        <div className="section-heading"><span>02</span><div><h2>发布生成结果</h2><p>B2 是阅读真值与 CDN，ES 只做可重建搜索索引，Hugging Face 保存私有 Canonical 副本。</p></div></div>
        <div className="publisher-grid">
          <Publisher name="b2" title="Backblaze B2" detail={publishers.b2.deliveryRemote} configured={publishers.b2.configured} selected={targets.includes("b2")} result={job.publish.b2?.status} onToggle={toggleTarget} />
          <Publisher name="elasticsearch" title="Elasticsearch" detail={publishers.elasticsearch.index} configured={publishers.elasticsearch.configured} selected={targets.includes("elasticsearch")} result={job.publish.elasticsearch?.status} onToggle={toggleTarget} />
          <Publisher name="huggingface" title="Hugging Face" detail={publishers.huggingface.repoId || "需要 HF_TOKEN / HF_DATASET_REPO"} configured={publishers.huggingface.configured} selected={targets.includes("huggingface")} result={job.publish.huggingface?.status} onToggle={toggleTarget} />
        </div>
        <div className="panel-actions"><button className="primary-button" disabled={busy || job.status === "publishing" || targets.length === 0} onClick={publish}>发布选中目标</button></div>
      </section>}
    </main>
  </>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div><strong>{value.toLocaleString()}</strong><span>{label}</span></div>;
}

function Publisher({ name, title, detail, configured, selected, result, onToggle }: { name: string; title: string; detail: string; configured: boolean; selected: boolean; result?: string; onToggle: (name: string) => void }) {
  return <label className={`publisher-card ${selected ? "selected" : ""} ${!configured ? "disabled" : ""}`}>
    <input type="checkbox" checked={selected && configured} disabled={!configured} onChange={() => onToggle(name)} />
    <b>{title}</b><small>{detail}</small><em>{result || (configured ? "READY" : "NOT CONFIGURED")}</em>
  </label>;
}
