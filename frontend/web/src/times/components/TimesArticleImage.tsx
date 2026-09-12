import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function TimesArticleImage({ src, alt, caption, loading = "lazy", className }: {
  src: string;
  alt: string;
  caption?: string;
  loading?: "eager" | "lazy";
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return <>
    <button type="button" aria-label="放大图片" onClick={() => setExpanded(true)} className="block w-full cursor-zoom-in border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-red">
      <img src={src} alt={alt || caption || "正文图片"} loading={loading} decoding="async" className={className} />
    </button>
    {expanded ? <ImagePreview src={src} alt={alt} caption={caption} onClose={() => setExpanded(false)} /> : null}
  </>;
}

function ImagePreview({ src, alt, caption, onClose }: { src: string; alt: string; caption?: string; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    const focused = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); focused?.focus(); };
  }, []);
  return createPortal(<dialog ref={ref} aria-label="图片预览" onCancel={onClose} className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none border-0 bg-black/90 p-4 text-white backdrop:bg-black/60">
    <div className="flex h-full flex-col gap-4">
      <div className="flex shrink-0 justify-end gap-6 font-sans text-sm">
        <button type="button" onClick={() => setZoomed((value) => !value)} className="min-h-11 border border-white/60 px-4">{zoomed ? "适应屏幕" : "继续放大"}</button>
        <button type="button" onClick={onClose} aria-label="关闭图片预览" className="min-h-11 border border-white/60 px-4">关闭 ×</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
        <button type="button" aria-label={zoomed ? "缩小图片" : "继续放大图片"} onClick={() => setZoomed((value) => !value)} className={`flex min-h-full items-center justify-center border-0 bg-transparent p-0 ${zoomed ? "w-[200%] cursor-zoom-out" : "h-full w-full cursor-zoom-in"}`}>
          <img src={src} alt={alt || caption || "放大图片"} className={zoomed ? "w-full max-w-none" : "max-h-full max-w-full object-contain"} />
        </button>
      </div>
      {caption ? <p className="m-0 max-h-[20vh] shrink-0 overflow-auto text-center font-sans text-xs leading-5 text-white/80">{caption}</p> : null}
    </div>
  </dialog>, document.body);
}
