import { Button, Modal } from "@jojo/ui";

interface Props {
  open: boolean;
  kicker: string;
  title: string;
  message: string;
  record?: string;
  details?: Array<{ label: string; value: string }>;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}

export function OperationDialog({
  open,
  kicker,
  title,
  message,
  record,
  details = [],
  confirmLabel = "完成",
  cancelLabel,
  onConfirm,
  onClose,
}: Props) {
  return (
    <Modal open={open} onClose={onClose}>
      <section className="operation-dialog">
        <header>
          <p className="eyebrow">{kicker}</p>
          <h2>{title}</h2>
        </header>
        <div className="dialog-body">
          <p>{message}</p>
          {record && <strong className="dialog-record">{record}</strong>}
          {details.map((detail) => (
            <div className="dialog-detail" key={detail.label}>
              <span>{detail.label}</span>
              <code>{detail.value}</code>
            </div>
          ))}
        </div>
        <footer>
          {cancelLabel && (
            <Button variant="outline" onClick={onClose}>
              {cancelLabel}
            </Button>
          )}
          <Button onClick={onConfirm}>{confirmLabel}</Button>
        </footer>
      </section>
    </Modal>
  );
}
