import { Button, Field, TextInput } from "@jojo/ui";
import type {
  FileMapping,
  Progress,
  Publication,
  StagingResult,
  VuePreview,
} from "../lib/api";
import { ResultSummary, SectionHeading, VueDiffPreview } from "./components";

export interface NewPublicationDraft {
  code: string;
  name: string;
  type: Publication["type"];
  description: string;
  default_date: string;
}

export function PublicationStep({
  publications,
  onSelect,
  onCreate,
}: {
  publications: Publication[];
  onSelect: (publication: Publication) => void;
  onCreate: () => void;
}) {
  return (
    <>
      <SectionHeading
        number="01"
        title="选择报刊"
        note="既有报刊直接进入导入；新刊只在最终提交时写入配置。"
      />
      <div className="publication-grid">
        {publications.map((publication) => (
          <button
            className="publication-card"
            key={publication.code}
            onClick={() => onSelect(publication)}
          >
            <span>{publication.type === "newspaper" ? "报纸" : "期刊"}</span>
            <b>{publication.name}</b>
            <small>{publication.code}</small>
          </button>
        ))}
        <button className="publication-card create" onClick={onCreate}>
          <b>＋ 新建报刊</b>
          <small>配置将在发布时落盘</small>
        </button>
      </div>
    </>
  );
}

export function FolderStep({
  publication,
  sourceDir,
  busy,
  onSourceDir,
  onBrowse,
  onScan,
}: {
  publication?: Publication;
  sourceDir: string;
  busy: boolean;
  onSourceDir: (value: string) => void;
  onBrowse: () => void;
  onScan: () => void;
}) {
  return (
    <>
      <SectionHeading
        number="02"
        title="选择 PDF 来源"
        note={`${publication?.name || "未选择报刊"} · 支持递归扫描子目录`}
      />
      <div className="source-picker">
        <Field label="本机目录">
          <TextInput
            value={sourceDir}
            onChange={(event) => onSourceDir(event.target.value)}
            placeholder="C:/data/newspapers/..."
          />
        </Field>
        <Button variant="outline" onClick={onBrowse}>
          浏览文件夹
        </Button>
        <Button disabled={!sourceDir || busy} onClick={onScan}>
          {busy ? "扫描中…" : "扫描 PDF"}
        </Button>
      </div>
    </>
  );
}

export function MappingStep({
  mapping,
  aiPrompt,
  rule,
  busy,
  onRule,
  onApplyRule,
  onIterateRule,
  onBack,
  onStage,
}: {
  mapping: FileMapping[];
  aiPrompt?: string;
  rule: string;
  busy: boolean;
  onRule: (value: string) => void;
  onApplyRule: () => void;
  onIterateRule: () => void;
  onBack: () => void;
  onStage: () => void;
}) {
  const successful = mapping.filter((item) => item.success);
  const failed = mapping.filter((item) => !item.success);
  return (
    <>
      <SectionHeading
        number="03"
        title="校对文件名映射"
        note={`${successful.length} 个可处理，${failed.length} 个需修正`}
      />
      <div className="mapping-table">
        <div className="table-head">
          <span>原始文件</span>
          <span>目标文件名</span>
          <span>状态</span>
        </div>
        {mapping.map((item) => (
          <div className="table-row" key={`${item.rel_path}-${item.original}`}>
            <span>{item.rel_path || item.original}</span>
            <span>{item.renamed || "—"}</span>
            <span className={item.success ? "status-ok" : "status-error"}>
              {item.success ? "可处理" : item.error || "未匹配"}
            </span>
          </div>
        ))}
      </div>
      {failed.length > 0 && (
        <div className="rule-workbench">
          <div>
            <h3>规则修正台</h3>
            <p>把下方提示交给模型，将返回的 JSON 规则贴回这里测试。</p>
          </div>
          {aiPrompt && (
            <details>
              <summary>查看 AI 提示词</summary>
              <pre>{aiPrompt}</pre>
            </details>
          )}
          <textarea
            value={rule}
            onChange={(event) => onRule(event.target.value)}
            placeholder={'{"pattern":"…","replacement":"…"}'}
          />
          <div className="button-row">
            <Button
              disabled={!rule || busy}
              variant="outline"
              onClick={onApplyRule}
            >
              测试并应用规则
            </Button>
            <Button disabled={busy} variant="text" onClick={onIterateRule}>
              生成下一轮提示词
            </Button>
          </div>
        </div>
      )}
      <div className="panel-actions">
        <Button variant="outline" onClick={onBack}>
          返回
        </Button>
        <Button disabled={!successful.length || busy} onClick={onStage}>
          开始预处理
        </Button>
      </div>
    </>
  );
}

export function ProcessingStep({
  progress,
  staging,
  progressValue,
  busy,
  commitRunning,
  onCancel,
  onBack,
  onCommit,
}: {
  progress?: Progress;
  staging?: StagingResult;
  progressValue: number;
  busy: boolean;
  commitRunning: boolean;
  onCancel: () => void;
  onBack: () => void;
  onCommit: () => void;
}) {
  return (
    <>
      <SectionHeading
        number="04"
        title={staging ? "核对预处理结果" : "正在处理"}
        note={progress?.unit_label || "PDF 文件与页面"}
      />
      <div className="progress-block">
        <div>
          <span style={{ width: `${progressValue}%` }} />
        </div>
        <b>{progressValue}%</b>
        <p>{progressLabel(progress)}</p>
      </div>
      {!staging && (
        <div className="panel-actions">
          <Button disabled={busy} variant="outline" onClick={onCancel}>
            取消处理
          </Button>
        </div>
      )}
      {staging && (
        <>
          <ResultSummary staging={staging} />
          <div className="panel-actions">
            <Button disabled={commitRunning} variant="outline" onClick={onBack}>
              返回校对
            </Button>
            <Button disabled={busy || commitRunning} onClick={onCommit}>
              {commitRunning ? "正在提交…" : "确认提交"}
            </Button>
          </div>
        </>
      )}
    </>
  );
}

export function CompleteStep({
  publication,
  isNewPublication,
  coverImageData,
  preview,
  busy,
  onCover,
  onGenerateVue,
  onReset,
  onApplyVue,
}: {
  publication?: Publication;
  isNewPublication: boolean;
  coverImageData?: string;
  preview?: VuePreview;
  busy: boolean;
  onCover: (file?: File) => void;
  onGenerateVue: () => void;
  onReset: () => void;
  onApplyVue: () => void;
}) {
  return (
    <>
      <SectionHeading
        number="05"
        title="数据发布完成"
        note={`${publication?.name || ""} 已写入目标存储`}
      />
      <div className="completion-card">
        <span>✓</span>
        <div>
          <b>PDF 数据已就绪</b>
          <p>可以继续生成前端报刊数据，或开始下一次导入。</p>
        </div>
      </div>
      {isNewPublication && (
        <div className="cover-picker">
          <div>
            <b>报刊封面</b>
            <p>可选，应用页面代码时保存为 625 × 250 JPEG。</p>
          </div>
          {coverImageData && <img alt="报刊封面预览" src={coverImageData} />}
          <input
            accept="image/png,image/jpeg,image/gif,image/webp"
            type="file"
            onChange={(event) => onCover(event.target.files?.[0])}
          />
        </div>
      )}
      <div className="panel-actions">
        <Button variant="outline" onClick={onGenerateVue}>
          {busy ? "生成中…" : "生成页面代码预览"}
        </Button>
        <Button onClick={onReset}>导入另一批文件</Button>
      </div>
      {preview && (
        <VueDiffPreview preview={preview} busy={busy} onApply={onApplyVue} />
      )}
    </>
  );
}

export function NewPublicationDialog({
  draft,
  busy,
  onDraft,
  onFetchDescription,
  onCancel,
  onCreate,
}: {
  draft: NewPublicationDraft;
  busy: boolean;
  onDraft: (draft: NewPublicationDraft) => void;
  onFetchDescription: () => void;
  onCancel: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="dialog-backdrop">
      <div className="create-dialog">
        <h2>新建报刊</h2>
        <p>这里创建的是待发布配置，只有最终提交后才会进入 config.json。</p>
        <div className="form-grid">
          <Field label="报刊代码">
            <TextInput
              value={draft.code}
              onChange={(event) =>
                onDraft({ ...draft, code: event.target.value.toUpperCase() })
              }
            />
          </Field>
          <Field label="中文名称">
            <TextInput
              value={draft.name}
              onChange={(event) =>
                onDraft({ ...draft, name: event.target.value })
              }
            />
          </Field>
          <Field label="类型">
            <select
              value={draft.type}
              onChange={(event) =>
                onDraft({
                  ...draft,
                  type: event.target.value as Publication["type"],
                })
              }
            >
              <option value="newspaper">报纸</option>
              <option value="journal">期刊</option>
            </select>
          </Field>
          <Field label="默认日期">
            <TextInput
              value={draft.default_date}
              onChange={(event) =>
                onDraft({ ...draft, default_date: event.target.value })
              }
            />
          </Field>
        </div>
        <Field label="说明">
          <div className="input-with-action">
            <TextInput
              value={draft.description}
              onChange={(event) =>
                onDraft({ ...draft, description: event.target.value })
              }
            />
            <Button
              disabled={busy || !draft.name}
              variant="text"
              onClick={onFetchDescription}
            >
              从百科获取
            </Button>
          </div>
        </Field>
        <div className="panel-actions">
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button
            disabled={busy || !draft.code || !draft.name}
            onClick={onCreate}
          >
            创建并继续
          </Button>
        </div>
      </div>
    </div>
  );
}

function progressLabel(progress?: Progress) {
  if (!progress) return "正在等待后台任务…";
  if (progress.status === "failed") return progress.error || "任务失败";
  if (progress.status === "completed") return "处理完成，请核对结果";
  return `${progress.completed_files || 0} / ${progress.total_files || 0} ${progress.unit_label || "文件"}`;
}
