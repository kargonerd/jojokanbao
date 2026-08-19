import { useEffect, useRef, useState, type FormEvent } from 'react';

export type CloseChoice = 'tray' | 'quit' | 'cancel';

interface CloseChoiceDialogProps {
  open: boolean;
  onChoose: (choice: CloseChoice) => void;
}

export function CloseChoiceDialog({ open, onChoose }: CloseChoiceDialogProps) {
  const [choice, setChoice] = useState<'tray' | 'quit'>('tray');
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setChoice('tray');
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => confirmButtonRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onChoose('cancel');
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, [open, onChoose]);

  if (!open) return null;

  const confirm = (event: FormEvent) => {
    event.preventDefault();
    onChoose(choice);
  };

  return (
    <div className="close-choice-backdrop" onMouseDown={() => onChoose('cancel')}>
      <form
        aria-describedby="close-choice-description"
        aria-labelledby="close-choice-title"
        aria-modal="true"
        className="close-choice-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={confirm}
        role="dialog"
      >
        <h2 id="close-choice-title">关闭窗口</h2>
        <p id="close-choice-description">请选择以后点击关闭按钮时的操作。之后可以在设置中修改。</p>

        <fieldset>
          <legend>关闭窗口时</legend>
          <label className={choice === 'tray' ? 'is-selected' : undefined}>
            <input
              checked={choice === 'tray'}
              name="close-choice"
              onChange={() => setChoice('tray')}
              type="radio"
            />
            <span><strong>最小化到系统托盘</strong><small>应用继续在后台运行</small></span>
          </label>
          <label className={choice === 'quit' ? 'is-selected' : undefined}>
            <input
              checked={choice === 'quit'}
              name="close-choice"
              onChange={() => setChoice('quit')}
              type="radio"
            />
            <span><strong>直接退出应用</strong><small>完全关闭 JOJO看报</small></span>
          </label>
        </fieldset>

        <div className="close-choice-buttons">
          <button className="is-secondary" onClick={() => onChoose('cancel')} type="button">取消</button>
          <button ref={confirmButtonRef} type="submit">确认</button>
        </div>
      </form>
    </div>
  );
}
