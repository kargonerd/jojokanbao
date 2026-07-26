import { Button, Modal } from "@jojo/ui";
import type { MigrationPreview } from "../lib/api";

interface Props {
  preview?: MigrationPreview;
  applying: boolean;
  onApply: () => void;
  onClose: () => void;
}

export function MigrationPreviewDialog({
  preview,
  applying,
  onApply,
  onClose,
}: Props) {
  if (!preview) return null;

  const isDelete = preview.migration.operation === "delete";
  return (
    <Modal open onClose={onClose}>
      <section className="migration-preview-dialog">
        <header>
          <div>
            <p className="eyebrow">MIGRATION PREVIEW / 写入前检查</p>
            <h2>{isDelete ? "删除墓碑预览" : "修复版本预览"}</h2>
          </div>
          <span className="preview-status">尚未写入</span>
        </header>
        <div className="preview-ledger">
          <div>
            <span>目标索引</span>
            <code>{preview.migration.index}</code>
          </div>
          <div>
            <span>原文档 ID</span>
            <code>{preview.migration.supersedesId}</code>
          </div>
          <div>
            <span>新版本 ID</span>
            <code>{preview.migration.id}</code>
          </div>
        </div>
        <div className="preview-json-grid">
          <section>
            <h3>Migration JSON</h3>
            <p>确认后将以此内容生成本地审计文件。</p>
            <pre>{JSON.stringify(preview.migration, null, 2)}</pre>
          </section>
          <section>
            <h3>ES Payload</h3>
            <p>最终提交到 ES 的追加版本，不覆盖原文档。</p>
            <pre>{JSON.stringify(preview.esPayload, null, 2)}</pre>
          </section>
        </div>
        <div className="preview-hash">
          <span>PREVIEW SHA-256</span>
          <code>{preview.previewHash}</code>
        </div>
        <footer>
          <p>确认后才会生成 migration 文件并写入 ES。</p>
          <div>
            <Button variant="outline" disabled={applying} onClick={onClose}>
              返回修改
            </Button>
            <Button disabled={applying} onClick={onApply}>
              {applying
                ? "正在写入…"
                : isDelete
                  ? "确认写入删除墓碑"
                  : "确认写入 ES"}
            </Button>
          </div>
        </footer>
      </section>
    </Modal>
  );
}
