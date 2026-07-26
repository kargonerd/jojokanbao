import { useEffect, useMemo, useState } from "react";
import { LoadingSpinner } from "@jojo/ui";
import { PageTopbar } from "../components/PageTopbar";
import { OperationDialog } from "../components/OperationDialog";
import {
  watchProgress,
  type Progress,
  type Publication,
  type StagingResult,
  type VuePreview,
} from "../lib/api";
import { usePdfWorkflow } from "../stores/pdfWorkflowStore";
import { pdfApi } from "../pdf/api";
import { PdfStepRail } from "../pdf/components";
import {
  CompleteStep,
  FolderStep,
  MappingStep,
  NewPublicationDialog,
  PublicationStep,
  ProcessingStep,
  type NewPublicationDraft,
} from "../pdf/steps";

type Notice = { mode: "success" | "error"; title: string; message: string };
export function PdfDataPage() {
  const workflow = usePdfWorkflow();
  const [publications, setPublications] = useState<Publication[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [showCreate, setShowCreate] = useState(false);
  const [rule, setRule] = useState("");
  const [vuePreview, setVuePreview] = useState<VuePreview>();
  const [newPublication, setNewPublication] = useState<NewPublicationDraft>({
    code: "",
    name: "",
    type: "newspaper",
    description: "",
    default_date: "",
  });

  useEffect(() => {
    pdfApi
      .publications()
      .then((data) => setPublications(data.publications))
      .catch((error: Error) =>
        setNotice({
          mode: "error",
          title: "报刊加载失败",
          message: error.message,
        }),
      );
  }, []);

  useEffect(() => {
    if (!workflow.taskId) return;
    return watchProgress(
      workflow.taskId,
      (progress) => {
        workflow.setProgress(progress);
        if (
          progress.status === "completed" &&
          progress.task_type !== "commit"
        ) {
          const result = progress.results as StagingResult | undefined;
          if (result?.staging_id) workflow.setStaging(result);
        }
        if (
          progress.status === "completed" &&
          progress.task_type === "commit"
        ) {
          workflow.setStep("complete");
          setNotice({
            mode: "success",
            title: "发布完成",
            message: "PDF 文件与报刊配置已经提交。",
          });
        }
        if (progress.status === "failed") {
          setNotice({
            mode: "error",
            title: "处理失败",
            message: progress.error || "后台任务未完成。",
          });
        }
        if (progress.status === "cancelled") {
          workflow.setStep("mapping");
          setNotice({
            mode: "success",
            title: "处理已取消",
            message: "可以调整文件映射后重新开始。",
          });
        }
        if (progress.status === "not_found" && !workflow.staging) {
          workflow.setStep("mapping");
          setNotice({
            mode: "error",
            title: "任务已失效",
            message: "后台服务可能已经重启，请重新开始预处理。",
          });
        }
      },
      () =>
        setNotice({
          mode: "error",
          title: "进度连接中断",
          message: "请检查服务状态后重试。",
        }),
    );
  }, [workflow.taskId]);

  const successMapping = useMemo(
    () => workflow.mapping.filter((item) => item.success),
    [workflow.mapping],
  );
  const failedMapping = useMemo(
    () => workflow.mapping.filter((item) => !item.success),
    [workflow.mapping],
  );
  const progressValue = calculateProgress(workflow.progress);
  const commitRunning =
    workflow.progress?.task_type === "commit" &&
    !["completed", "failed", "cancelled", "not_found"].includes(
      workflow.progress.status,
    );

  async function createPublication() {
    setBusy(true);
    try {
      const data = await pdfApi.createPublication({
        ...newPublication,
      });
      setPublications((items) => [...items, data.publication]);
      workflow.setPublication(data.publication, true);
      setShowCreate(false);
    } catch (error) {
      setNotice({
        mode: "error",
        title: "创建失败",
        message: (error as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  async function fetchDescription() {
    if (!newPublication.name) return;
    setBusy(true);
    try {
      const data = await pdfApi.fetchDescription(newPublication.name);
      setNewPublication((draft) => ({
        ...draft,
        description: data.description,
      }));
    } catch (error) {
      setNotice({
        mode: "error",
        title: "简介获取失败",
        message: (error as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  async function browse() {
    setBusy(true);
    try {
      const data = await pdfApi.browseFolder();
      workflow.setSourceDir(data.path);
    } catch (error) {
      setNotice({
        mode: "error",
        title: "选择失败",
        message: (error as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  async function scan() {
    if (!workflow.publication || !workflow.sourceDir) return;
    setBusy(true);
    try {
      const data = await pdfApi.scan(workflow.sourceDir, workflow.publication);
      workflow.setScan(data.mapping, data.ai_prompt);
    } catch (error) {
      setNotice({
        mode: "error",
        title: "扫描失败",
        message: (error as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  async function applyRule() {
    if (!workflow.publication) return;
    setBusy(true);
    try {
      const parsed = JSON.parse(rule) as Record<string, unknown>;
      const data = await pdfApi.applyRule(
        parsed,
        failedMapping.map((item) => item.original),
        workflow.publication,
      );
      const replacements = new Map(
        data.results.map((item) => [item.original, item]),
      );
      workflow.setScan(
        workflow.mapping.map((item) => replacements.get(item.original) || item),
        workflow.aiPrompt,
      );
      await pdfApi.saveRule(parsed, workflow.publication);
    } catch (error) {
      setNotice({
        mode: "error",
        title: "规则应用失败",
        message: (error as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  async function stage() {
    if (!workflow.publication) return;
    setBusy(true);
    try {
      const data = await pdfApi.stage(
        workflow.sourceDir,
        workflow.publication,
        workflow.mapping,
        workflow.isNewPublication,
      );
      workflow.setTask(data.task_id, data.staging_id || "", true);
      workflow.setProgress({ status: "processing", task_type: "staging" });
    } catch (error) {
      setNotice({
        mode: "error",
        title: "预处理启动失败",
        message: (error as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!workflow.publication || !workflow.stagingId) return;
    setBusy(true);
    try {
      const data = await pdfApi.commit(
        workflow.stagingId,
        workflow.publication,
        workflow.isNewPublication,
      );
      workflow.setTask(data.task_id, workflow.stagingId);
      workflow.setProgress({ status: "processing", task_type: "commit" });
    } catch (error) {
      setNotice({
        mode: "error",
        title: "提交失败",
        message: (error as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  async function generateVue() {
    if (!workflow.publication) return;
    setBusy(true);
    try {
      const data = await pdfApi.previewVue(
        workflow.publication,
        workflow.isNewPublication,
      );
      setVuePreview(data);
    } catch (error) {
      setNotice({
        mode: "error",
        title: "代码预览失败",
        message: (error as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  async function applyVue() {
    if (!workflow.publication || !vuePreview) return;
    setBusy(true);
    try {
      await pdfApi.applyVue(
        workflow.publication,
        vuePreview,
        workflow.isNewPublication,
        workflow.coverImageData,
      );
      setNotice({
        mode: "success",
        title: "页面代码已更新",
        message: "Vue 报刊数据文件已应用。",
      });
    } catch (error) {
      setNotice({
        mode: "error",
        title: "应用失败",
        message: (error as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  async function cancelProcessing() {
    if (!workflow.stagingId) return;
    setBusy(true);
    try {
      await pdfApi.cancel(workflow.stagingId, workflow.taskId);
      workflow.setStep("mapping");
      setNotice({
        mode: "success",
        title: "处理已取消",
        message: "临时文件已经清理，可以调整映射后重新开始。",
      });
    } catch (error) {
      setNotice({
        mode: "error",
        title: "取消失败",
        message: (error as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  async function iterateRule() {
    if (!workflow.publication || !failedMapping.length) return;
    setBusy(true);
    try {
      const data = await pdfApi.iterateRule(
        workflow.publication,
        successMapping,
        failedMapping,
      );
      workflow.setScan(workflow.mapping, data.ai_prompt);
    } catch (error) {
      setNotice({
        mode: "error",
        title: "提示词生成失败",
        message: (error as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  function selectCover(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setNotice({
        mode: "error",
        title: "封面格式不支持",
        message: "请选择 PNG、JPEG、GIF 或 WebP 图片。",
      });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => workflow.setCoverImage(String(reader.result));
    reader.readAsDataURL(file);
  }

  return (
    <main>
      <PageTopbar
        eyebrow="DATA PIPELINE / PDF"
        title="PDF 数据管理"
        description="从原始报刊文件到线上数据，一条可检查、可回退的发布流程。"
      />
      <PdfStepRail workflow={workflow} />

      <section className="workspace-panel">
        {workflow.step === "publication" && (
          <PublicationStep
            publications={publications}
            onSelect={(publication) =>
              workflow.setPublication(publication, false)
            }
            onCreate={() => setShowCreate(true)}
          />
        )}

        {workflow.step === "folder" && (
          <FolderStep
            publication={workflow.publication}
            sourceDir={workflow.sourceDir}
            busy={busy}
            onSourceDir={workflow.setSourceDir}
            onBrowse={browse}
            onScan={scan}
          />
        )}

        {workflow.step === "mapping" && (
          <MappingStep
            mapping={workflow.mapping}
            aiPrompt={workflow.aiPrompt}
            rule={rule}
            busy={busy}
            onRule={setRule}
            onApplyRule={applyRule}
            onIterateRule={iterateRule}
            onBack={() => workflow.setStep("folder")}
            onStage={stage}
          />
        )}

        {workflow.step === "processing" && (
          <ProcessingStep
            progress={workflow.progress}
            staging={workflow.staging}
            progressValue={progressValue}
            busy={busy}
            commitRunning={commitRunning}
            onCancel={cancelProcessing}
            onBack={() => workflow.setStep("mapping")}
            onCommit={commit}
          />
        )}

        {workflow.step === "complete" && (
          <CompleteStep
            publication={workflow.publication}
            isNewPublication={workflow.isNewPublication}
            coverImageData={workflow.coverImageData}
            preview={vuePreview}
            busy={busy}
            onCover={selectCover}
            onGenerateVue={generateVue}
            onReset={workflow.reset}
            onApplyVue={applyVue}
          />
        )}
      </section>

      {showCreate && (
        <NewPublicationDialog
          draft={newPublication}
          busy={busy}
          onDraft={setNewPublication}
          onFetchDescription={fetchDescription}
          onCancel={() => setShowCreate(false)}
          onCreate={createPublication}
        />
      )}
      {busy && (
        <div className="corner-loading">
          <LoadingSpinner /> 正在处理
        </div>
      )}
      {notice && (
        <OperationDialog
          open
          kicker={
            notice.mode === "error" ? "OPERATION FAILED" : "OPERATION COMPLETE"
          }
          title={notice.title}
          message={notice.message}
          onClose={() => setNotice(undefined)}
          onConfirm={() => setNotice(undefined)}
        />
      )}
    </main>
  );
}

function calculateProgress(progress?: Progress) {
  if (!progress) return 0;
  if (progress.status === "completed") return 100;
  const done = progress.current_page || progress.completed_files || 0;
  const total = progress.total_pages || progress.total_files || 0;
  return total ? Math.min(99, Math.round((done / total) * 100)) : 0;
}
