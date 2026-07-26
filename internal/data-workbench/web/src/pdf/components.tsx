import { Button } from "@jojo/ui";
import type { MultiFileChange, StagingResult, VuePreview } from "../lib/api";
import type { PdfStep, PdfWorkflowState } from "../stores/pdfWorkflowStore";

export const pdfSteps = [
  ["publication", "01", "选择报刊"],
  ["folder", "02", "选择来源"],
  ["mapping", "03", "校对文件"],
  ["processing", "04", "处理发布"],
  ["complete", "05", "完成"],
] as const;

export function PdfStepRail({ workflow }: { workflow: PdfWorkflowState }) {
  return (
    <div className="step-rail">
      {pdfSteps.map(([key, number, label]) => (
        <button
          className={workflow.step === key ? "active" : ""}
          disabled={!canVisitStep(key, workflow)}
          key={key}
          onClick={() => workflow.setStep(key)}
        >
          <b>{number}</b>
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

export function SectionHeading({
  number,
  title,
  note,
}: {
  number: string;
  title: string;
  note: string;
}) {
  return (
    <header className="section-heading">
      <span>{number}</span>
      <div>
        <h2>{title}</h2>
        <p>{note}</p>
      </div>
    </header>
  );
}

export function ResultSummary({ staging }: { staging: StagingResult }) {
  return (
    <div className="result-summary">
      <article>
        <b>{staging.preview?.length || 0}</b>
        <span>待提交文件</span>
      </article>
      <article>
        <b>{staging.skipped?.length || 0}</b>
        <span>跳过</span>
      </article>
      <article>
        <b>{staging.errors?.length || 0}</b>
        <span>错误</span>
      </article>
    </div>
  );
}

export function VueDiffPreview({
  preview,
  busy,
  onApply,
}: {
  preview: VuePreview;
  busy: boolean;
  onApply: () => void;
}) {
  const files: MultiFileChange[] =
    preview.multi_file_diff?.files ||
    (preview.new_code
      ? [
          {
            filename: preview.vue_filename || "报刊页面",
            filepath: preview.vue_filename || "",
            status: preview.exists ? "modified" : "added",
            old_code: preview.old_code || "",
            new_code: preview.new_code,
            additions: 0,
            deletions: 0,
          },
        ]
      : []);

  return (
    <div className="diff-preview">
      <h3>页面代码变更 · {files.length} 个文件</h3>
      {files.map((file) => (
        <details key={file.filepath} open={files.length === 1}>
          <summary>
            {file.status === "added" ? "新增" : "修改"} · {file.filename}
          </summary>
          <pre>{file.new_code}</pre>
        </details>
      ))}
      <Button disabled={!files.length || busy} onClick={onApply}>
        应用页面代码
      </Button>
    </div>
  );
}

function canVisitStep(step: PdfStep, workflow: PdfWorkflowState) {
  if (step === "publication") return true;
  if (step === "folder") return Boolean(workflow.publication);
  if (step === "mapping") return workflow.mapping.length > 0;
  if (step === "processing")
    return Boolean(workflow.taskId || workflow.staging);
  return workflow.step === "complete";
}
