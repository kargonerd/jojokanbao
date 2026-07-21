import { useEffect, type ReactNode } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  size?: "default" | "medium" | "wide";
  surface?: "framed" | "bare";
}

export function Modal({
  open,
  onClose,
  children,
  size = "default",
  surface = "framed",
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/36 p-4" onClick={onClose}>
      <div
        className={`${size === "wide" ? "w-[1120px]" : size === "medium" ? "w-[620px]" : "w-[400px]"} max-w-full ${surface === "bare" ? "bg-transparent" : "border-4 border-red bg-paper shadow-[inset_0_0_0_8px_var(--color-paper),inset_0_0_0_10px_var(--color-red)]"} animate-[slideUp_.24s_ease-out]`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
