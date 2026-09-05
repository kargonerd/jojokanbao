import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

function visibleViewport() {
  const visual = window.visualViewport;
  const top = visual?.offsetTop ?? 0;
  const height = visual?.height ?? window.innerHeight;
  return { top, height, bottom: Math.max(0, window.innerHeight - top - height) };
}

export function BookNavigationSheet({ tab, onTabChange, onClose, panelClass, children }: {
  tab: "toc" | "search";
  onTabChange: (tab: "toc" | "search") => void;
  onClose: () => void;
  panelClass: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  const [drag, setDrag] = useState(0);
  const [viewport, setViewport] = useState(visibleViewport);
  const gesture = useRef<{ y: number; moved: boolean } | undefined>(undefined);
  const suppressPointerClick = useRef(false);

  useLayoutEffect(() => {
    const visual = window.visualViewport;
    const measure = () => setViewport(visibleViewport());
    measure();
    visual?.addEventListener("resize", measure);
    visual?.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    return () => {
      visual?.removeEventListener("resize", measure);
      visual?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, []);

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [onClose]);

  // Reserve only the part of the reader toolbar still above the keyboard.
  const viewportStyle = {
    top: viewport.top,
    height: viewport.height,
    "--book-navigation-bottom": `max(0px, calc(64px + env(safe-area-inset-bottom) - ${viewport.bottom}px))`,
  } as CSSProperties;

  return <div className="book-navigation-viewport" style={viewportStyle}>
    <button type="button" aria-hidden="true" tabIndex={-1} onClick={onClose} className="book-navigation-backdrop" />
    <aside aria-label={tab === "toc" ? "目录面板" : "全书搜索"} className={`book-navigation-sheet ${panelClass}`} style={{ height: `calc(${expanded ? "100% - 48px - var(--book-navigation-bottom)" : "66%"} - ${drag}px)` }}>
      <button type="button" aria-label="调整书内导航高度" aria-expanded={expanded} className="book-navigation-handle"
        onPointerDown={(event) => { suppressPointerClick.current = false; gesture.current = { y: event.clientY, moved: false }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={(event) => {
          if (!gesture.current) return;
          const distance = event.clientY - gesture.current.y;
          if (Math.abs(distance) > 5) gesture.current.moved = true;
          setDrag(Math.max(-viewport.height * .22, distance));
        }}
        onPointerUp={(event) => {
          if (!gesture.current) return;
          const distance = event.clientY - gesture.current.y;
          suppressPointerClick.current = gesture.current.moved || Math.abs(distance) > 5;
          gesture.current = undefined;
          if (distance > 80) onClose();
          else if (distance < -50) setExpanded(true);
          setDrag(0);
        }}
        onPointerCancel={() => { gesture.current = undefined; suppressPointerClick.current = false; setDrag(0); }}
        onClick={(event) => { if (event.detail === 0 || !suppressPointerClick.current) setExpanded((value) => !value); suppressPointerClick.current = false; }}
        onKeyDown={(event) => { if (event.key === "ArrowUp") { event.preventDefault(); setExpanded(true); } if (event.key === "ArrowDown") { event.preventDefault(); onClose(); } }}
      ><span aria-hidden="true" /></button>
      <div className="book-navigation-toolbar">
        <div role="tablist" aria-label="书内导航" className="book-navigation-tabs">
          {(["search", "toc"] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => onTabChange(value)}>{value === "search" ? "⌕ 搜本书" : "目录"}</button>)}
        </div>
        <button type="button" className="book-navigation-close" aria-label="关闭书内导航" onClick={onClose}>×</button>
      </div>
      {children}
    </aside>
  </div>;
}
