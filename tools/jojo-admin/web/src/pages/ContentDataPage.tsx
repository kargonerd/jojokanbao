import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PageTopbar } from "../components/PageTopbar";
import { contentApi, type ContentJob, type ContentPublication, type PublisherStatus } from "../content/api";
import "./ContentDataPage.css";

const steps = ["选择文件", "处理与预览", "设置发布", "查看结果"];
const destinations = [
  { name: "huggingface", title: "Hugging Face", description: "保存书籍源数据" },
  { name: "b2", title: "Backblaze B2", description: "供线上馆藏与阅读使用" },
] as const;
const resultDestinations = [...destinations, { name: "elasticsearch", title: "全文检索", description: "发布后同步" }] as const;
const ready = (job?: ContentJob) => ["ready", "published", "publish-failed"].includes(job?.status ?? "");
const busyJob = (job?: ContentJob) => ["queued", "building", "publishing"].includes(job?.status ?? "");
const initialStep = (job: ContentJob) => Object.keys(job.publish).length || job.status === "publishing" ? 4 : 2;
const visibility = (status?: string) => status === "published" ? "已发布，在馆藏展示" : "草稿，不在馆藏展示";
const audience = (access?: string) => access === "authenticated" ? "阅读门槛：登录后阅读（软门槛）" : "阅读门槛：任何人";
const titleOf = (job: ContentJob) => job.report?.itemsBuilt[0]?.itemTitle || job.inputPaths?.[0]?.split(/[\\/]/).pop() || job.jobId;

export function ContentDataPage() {
  const [params, setParams] = useSearchParams();
  const requestedJob = params.get("job");
  const requestedStep = Number(params.get("step"));
  const [selectedFile, setSelectedFile] = useState<File>();
  const [fetchAssets, setFetchAssets] = useState(true);
  const [publicationStatus, setPublicationStatus] = useState<ContentJob["publicationStatus"]>("draft");
  const [access, setAccess] = useState<ContentJob["access"]>("public");
  const [job, setJob] = useState<ContentJob>();
  const [history, setHistory] = useState<ContentJob[]>([]);
  const [publishers, setPublishers] = useState<PublisherStatus>();
  const [targets, setTargets] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [loadingJob, setLoadingJob] = useState(false);
  const loading = initializing || loadingJob;
  const fileInput = useRef<HTMLInputElement>(null);
  const stepNavigation = useRef<HTMLElement>(null);
  const stepPanel = useRef<HTMLElement>(null);

  useEffect(() => {
    let active = true;
    Promise.all([contentApi.status(), contentApi.jobs()]).then(([status, jobs]) => {
      if (!active) return;
      setPublishers(status.publishers);
      setTargets(Object.entries(status.publishers).filter(([name, value]) => name !== "elasticsearch" && value.configured).map(([name]) => name));
      setHistory(jobs.jobs);
      // Opening /content resumes the latest import; ?step=1 explicitly starts a new book.
      if (!requestedJob && requestedStep !== 1 && jobs.jobs[0]) {
        setParams({ job: jobs.jobs[0].jobId, step: String(initialStep(jobs.jobs[0])) }, { replace: true });
      }
    }).catch((reason: Error) => { if (active) setError(reason.message); })
      .finally(() => { if (active) setInitializing(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!requestedJob) { setJob(undefined); setLoadingJob(false); return; }
    if (requestedJob === job?.jobId) { setLoadingJob(false); return; }
    let active = true;
    setJob(undefined); setError(""); setLoadingJob(true);
    contentApi.job(requestedJob).then(({ job: value }) => {
      if (active) acceptJob(value);
    }).catch((reason: Error) => { if (active) setError(reason.message); })
      .finally(() => { if (active) setLoadingJob(false); });
    return () => { active = false; };
  }, [requestedJob]);

  useEffect(() => {
    setPublicationStatus(job?.publicationStatus ?? "draft");
    setAccess(job?.access ?? "public");
  }, [job?.jobId, job?.publicationStatus, job?.access]);

  useEffect(() => {
    if (!job || !busyJob(job)) return;
    let active = true;
    let timer: number;
    const poll = async () => {
      try {
        const result = await contentApi.job(job.jobId);
        if (active) { acceptJob(result.job); setError(""); }
      } catch (reason) { if (active) setError(`状态暂时无法刷新：${(reason as Error).message}。正在重试。`); }
      if (active) timer = window.setTimeout(poll, 1_500);
    };
    timer = window.setTimeout(poll, 1_500);
    return () => { active = false; window.clearTimeout(timer); };
  }, [job?.jobId, job?.status]);

  const working = busy || busyJob(job);
  const hasResult = !!job && (Object.keys(job.publish).length > 0 || job.status === "publishing");
  const step = !job ? 1 : job.status === "publishing" ? 4
    : requestedStep === 3 && ready(job) ? 3
      : requestedStep === 4 && hasResult ? 4 : 2;
  const progress = job?.progress.total ? Math.min(100, Math.round(Number(job.progress.current || 0) / Number(job.progress.total) * 100)) : ready(job) ? 100 : 0;
  const failedTargets = resultDestinations.filter(({ name }) => job?.publish[name]?.status === "failed").map(({ name }) => name);

  useEffect(() => {
    if (loading) return;
    const heading = stepPanel.current?.querySelector<HTMLElement>("h2");
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    stepNavigation.current?.scrollIntoView?.({ block: "start" });
  }, [step, job?.jobId, loading]);

  function acceptJob(value: ContentJob) {
    setJob(value);
    setHistory((current) => [value, ...current.filter((entry) => entry.jobId !== value.jobId)].slice(0, 20));
  }

  function go(next: number) {
    setError("");
    setParams(job ? { job: job.jobId, step: String(next) } : { step: "1" });
  }

  function newBook() {
    setSelectedFile(undefined); setJob(undefined); setError("");
    setParams({ step: "1" });
  }

  function selectFile(file: File | undefined) {
    if (!file) return;
    setError("");
    if (!/\.(epub|json|azw|mobi|prc)$/i.test(file.name)) {
      setSelectedFile(undefined);
      if (fileInput.current) fileInput.current.value = "";
      setError("请选择 EPUB、JSON、AZW、MOBI 或 PRC 文件。");
      return;
    }
    setSelectedFile(file);
  }

  async function importFile() {
    if (!selectedFile || working) return;
    setBusy(true); setError("");
    try {
      const { job: value } = await contentApi.importFile(selectedFile, fetchAssets, "draft", "public");
      acceptJob(value);
      setParams({ job: value.jobId, step: "2" });
      setSelectedFile(undefined);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  async function publish(selectedTargets = targets, status = publicationStatus, gate = access) {
    if (!job || working || job.newerJobId) return;
    setBusy(true); setError("");
    try {
      acceptJob((await contentApi.publish(job.jobId, selectedTargets, status, gate)).job);
      go(4);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  function editPublication() {
    if (!job) return;
    setPublicationStatus(job.publicationStatus); setAccess(job.access);
    setTargets(destinations.filter(({ name }) => publishers?.[name].configured).map(({ name }) => name));
    go(3);
  }

  return <>
    <PageTopbar eyebrow="内容管理" title="书籍导入与发布" description="先预览，再发布。已导入的书籍可以随时回来继续处理。" />
    <main className="content-workbench book-wizard">
      <div className="book-workspace-switcher">
        <label>最近导入<select aria-label="最近导入" value={requestedJob ?? ""} disabled={working || loading} onChange={(event) => {
          const value = history.find((entry) => entry.jobId === event.target.value);
          if (value) setParams({ job: value.jobId, step: String(initialStep(value)) });
          else newBook();
        }}><option value="">新书籍</option>{history.map((entry) => <option key={entry.jobId} value={entry.jobId}>{entry.newerJobId ? "[旧版本] " : ""}{titleOf(entry)} · {new Date(entry.createdAt).toLocaleString("zh-CN")}</option>)}</select></label>
        <button className="secondary-button" disabled={working || loading} onClick={newBook}>导入另一本</button>
      </div>
      <nav ref={stepNavigation} aria-label="导入与发布步骤" className="book-steps"><ol>{steps.map((label, index) => {
        const number = index + 1;
        const enabled = number === step || number === 2 && !!job || number === 3 && ready(job) || number === 4 && hasResult;
        return <li key={label}><button aria-current={step === number ? "step" : undefined} disabled={loading || working || !enabled} onClick={() => go(number)}><span>{String(number).padStart(2, "0")}</span>{label}</button></li>;
      })}</ol></nav>

      <section ref={stepPanel} className="workspace-panel book-step-panel" aria-label={steps[step - 1]} aria-busy={loading || working}>
        {error && <p className="content-error" role="alert">{error}</p>}
        {job?.newerJobId && <div className="content-error"><p>这是旧的导入版本，上传记录仅供回看。请使用最新版本，避免覆盖修复后的内容。</p><Link to={`/content?job=${job.newerJobId}&step=3`}>切换到最新版本</Link></div>}
        {loading ? <p role="status">正在读取导入记录…</p> : <>
          {step === 1 && <>
            <h2>选择一本电子书</h2>
            <p className="book-step-intro">支持 EPUB、微信读书 JSON，以及无 DRM 的 AZW / MOBI / PRC。每次选择一个文件。</p>
            <div className="book-file-choice">
              <button className="secondary-button" disabled={working} onClick={() => fileInput.current?.click()}>选择电子书文件</button>
              <p role="status">{selectedFile?.name ?? "尚未选择文件"}{selectedFile && <small>{(selectedFile.size / 1024 / 1024).toFixed(2)} MB</small>}</p>
              <input ref={fileInput} hidden type="file" aria-label="电子书文件" accept=".epub,.json,.azw,.mobi,.prc" disabled={working} onChange={(event) => selectFile(event.target.files?.[0])} />
            </div>
            <label className="book-assets-choice"><input type="checkbox" checked={fetchAssets} disabled={working} onChange={(event) => setFetchAssets(event.target.checked)} /> 导入封面与正文图片</label>
            <footer className="book-step-actions"><p>下一步在本机处理文件，不会上传或公开。</p><button className="primary-button" disabled={working || !selectedFile} onClick={importFile}>{busy ? "正在上传文件…" : "开始处理"}</button></footer>
          </>}

          {step === 2 && job && <>
            <h2>{ready(job) ? "检查导入结果" : busyJob(job) ? "正在处理电子书" : "处理未完成"}</h2>
            <p className="book-step-intro">{titleOf(job)}</p>
            <p role="status">{job.message}</p>
            <div className="content-progress" role="progressbar" aria-label="电子书处理进度" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${progress}%` }} /></div>
            {job.report && <div className="book-import-summary"><span>{job.report.chapters} 个章节</span><span>{job.report.assets} 个图片资源</span><span>{job.report.annotations} 条注释</span></div>}
            {ready(job) && <div className="book-preview-invitation"><p>打开预览，检查目录、正文、图片与脚注。</p><Link className="secondary-button" to={`/content/${job.jobId}/preview`}>打开阅读预览</Link></div>}
            <JobDetails job={job} />
            <footer className="book-step-actions"><button className="secondary-button" disabled={working} onClick={newBook}>重新选择文件</button><button className="primary-button" disabled={working || !ready(job)} onClick={() => go(3)}>确认预览，设置发布</button></footer>
          </>}

          {step === 3 && job && <>
            <h2>设置发布</h2><p className="book-step-intro">{titleOf(job)}</p>
            <fieldset className="book-visibility-options"><legend>书籍发布状态</legend>
              <label className={publicationStatus === "draft" ? "selected" : ""}><input type="radio" name="publication" value="draft" checked={publicationStatus === "draft"} disabled={working} onChange={() => setPublicationStatus("draft")} /><span><b>草稿</b><small>上传保存，不在馆藏展示。</small></span></label>
              <label className={publicationStatus === "published" ? "selected" : ""}><input type="radio" name="publication" value="published" checked={publicationStatus === "published"} disabled={working} onChange={() => setPublicationStatus("published")} /><span><b>发布到馆藏</b><small>同步到阅读站点后，在馆藏展示。</small></span></label>
            </fieldset>
            <p className="book-setting-help">书源：{job?.librarySource === "community" ? "网友分享（默认关闭，需登录并开启书源后可见）" : "JOJO书库"}</p>
            <label className="book-access-choice">阅读门槛<select value={job?.librarySource === "community" ? "authenticated" : access} disabled={working || job?.librarySource === "community"} onChange={(event) => setAccess(event.target.value as ContentJob["access"])}><option value="public">任何人</option><option value="authenticated">仅登录用户（软门槛）</option></select></label>
            <fieldset className="book-upload-options"><legend>上传到哪里</legend>{destinations.map(({ name, title, description }) => <label key={name} className={targets.includes(name) ? "selected" : ""}>
              <input type="checkbox" checked={targets.includes(name)} disabled={working || !publishers?.[name].configured} onChange={() => setTargets((current) => current.includes(name) ? current.filter((item) => item !== name) : [...current, name])} />
              <span><b>{title}</b><small>{description}</small></span><span className="book-target-config">{publishers?.[name].configured ? "已配置" : "未配置"}</span>
            </label>)}</fieldset>
            <p className="book-setting-help">上传完成后自动同步全文检索。草稿不新增索引；失败可在结果页单独重试。</p>
            {publicationStatus === "published" && !targets.includes("b2") && <p className="book-setting-help">未选择 Backblaze B2，本次不会更新线上馆藏。</p>}
            {hasResult && <p className="book-setting-help">修改状态会同步到此前上传的目标，无需重新导入文件。</p>}
            <footer className="book-step-actions"><button className="secondary-button" disabled={working} onClick={() => go(2)}>上一步：预览</button><button className="primary-button" disabled={working || targets.length === 0 || !!job.newerJobId} onClick={() => void publish()}>{busy ? "正在保存设置…" : hasResult ? "保存设置并同步" : publicationStatus === "published" ? "确认发布并上传" : "保存草稿并上传"}</button></footer>
          </>}

          {step === 4 && job && <>
            <div className="book-result-heading" aria-live="polite"><h2>{job.status === "publishing" ? "正在上传" : job.newerJobId ? "历史上传记录" : job.status === "publish-failed" ? "部分上传失败" : "上传完成"}</h2><p>{titleOf(job)}</p></div>
            <div className="book-visibility-result" role="status">
              <strong>{job.publish.b2?.status === "completed" ? `馆藏状态：${visibility(job.publish.b2.publicationStatus ?? job.publicationStatus)}` : job.publish.b2 ? "馆藏状态：等待同步确认" : "尚未上传到线上阅读站点"}</strong>
              <p>{job.publish.b2?.status === "completed" ? audience(job.publish.b2.access ?? job.access) : `本次设置：${visibility(job.publicationStatus)}`}</p>
              {job.publish.b2?.status === "completed" && job.publish.b2.result?.cache?.status === "verified" && <p>已核对线上目录、发布状态与阅读文件。</p>}
            </div>
            <div className="book-upload-results">{resultDestinations.map(({ name, title }) => <UploadResult key={name} title={title} result={job.publish[name]} job={job} />)}</div>
            {job.status === "publish-failed" && <p className="book-setting-help">部分文件可能已上传；重试同步完成后，才能确认线上状态。</p>}
            {job.status === "published" && job.publicationStatus === "draft" && <p className="book-setting-help">要让读者在馆藏看到这本书，请点击“修改发布设置”，选择“发布到馆藏”并同步。</p>}
            <JobDetails job={job} />
            <footer className="book-step-actions"><Link className="secondary-button" to={`/content/${job.jobId}/preview`}>查看阅读预览</Link><div>{failedTargets.length > 0 && <button className="primary-button" disabled={working || !!job.newerJobId} onClick={() => void publish(failedTargets, job.publicationStatus, job.access)}>重试失败目标</button>}<button className={failedTargets.length ? "secondary-button" : "primary-button"} disabled={working || !ready(job) || !!job.newerJobId} onClick={editPublication}>修改发布设置</button></div></footer>
          </>}
        </>}
      </section>
    </main>
  </>;
}

function JobDetails({ job }: { job: ContentJob }) {
  return <div className="book-job-details">
    {!!job.report?.diagnostics.length && <details className="diagnostics"><summary>{job.report.diagnostics.length} 条导入说明</summary>{job.report.diagnostics.map((item, index) => <p key={index}>{item.message}</p>)}</details>}
    <details className="job-log"><summary>处理日志</summary><pre>{job.logs.join("\n")}</pre></details>
  </div>;
}

function UploadResult({ title, result, job }: { title: string; result?: ContentPublication; job: ContentJob }) {
  const labels: Record<string, string> = { completed: "同步完成", failed: "同步失败", pending: "等待同步", uploading: "正在同步" };
  const successful = result?.status === "completed" ? result : result?.lastSuccessful;
  const commit = successful?.result?.commit ?? successful?.result?.commitUrl;
  return <div className="book-upload-result">
    <div><b>{title}</b><span>{result ? labels[result.status] || "等待确认" : title === "全文检索" ? "尚未同步" : "未选择上传"}</span></div>
    {result?.result?.status === "skipped" && <p>{String(result.result.reason)}</p>}
    {typeof result?.result?.created === "number" && <p>新增 {result.result.created} 章 · 已有 {Number(result.result.unchanged ?? 0)} 章</p>}
    {result?.message && <p className="book-upload-error">{result.message}</p>}
    {successful && <p>{result?.status === "completed" ? "已同步" : "上次成功同步"}：{visibility(successful.publicationStatus ?? job.publicationStatus)} · {audience(successful.access ?? job.access)}<br />{successful.completedAt && <time dateTime={successful.completedAt}>{new Date(successful.completedAt).toLocaleString("zh-CN")}</time>}{typeof commit === "string" && commit.startsWith("https://huggingface.co/") && <a href={commit} target="_blank" rel="noreferrer">查看上传记录</a>}</p>}
  </div>;
}
