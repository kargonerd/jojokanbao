import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

function visibleViewport() {
  const visual = window.visualViewport;
  const top = visual?.offsetTop ?? 0;
  const height = visual?.height ?? window.innerHeight;
  return { top, height, bottom: Math.max(0, window.innerHeight - top - height) };
}

export function BookNavigationSheet({ tab, onTabChange, title, label, compact = false, mobile, onClose, panelClass, children }: {
  tab?: "toc" | "search";
  onTabChange?: (tab: "toc" | "search") => void;
  title?: string;
  label?: string;
  compact?: boolean;
  mobile: boolean;
  onClose: () => void;
  panelClass: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(!compact);
  const [viewport, setViewport] = useState(visibleViewport);
  const sheet = useRef<HTMLElement>(null);
  const gesture = useRef<{ pointerId: number; y: number; origin: number; minimum: number; height: number; lastY: number; time: number; velocity: number; moved: boolean } | undefined>(undefined);
  const suppressPointerClick = useRef(false);
  const settlingFrom = useRef<number | undefined>(undefined);
  const move = (distance: number) => sheet.current?.style.setProperty("--book-navigation-drag", `${distance}px`);
  const resetDrag = () => {
    gesture.current = undefined;
    if (sheet.current) delete sheet.current.dataset.dragging;
    move(0);
  };
  const changeExpanded = (value: boolean) => {
    if (value !== expanded) settlingFrom.current = sheet.current?.getBoundingClientRect().top;
    else resetDrag();
    setExpanded(value);
  };
  useLayoutEffect(() => {
    const node = sheet.current;
    const previousTop = settlingFrom.current;
    settlingFrom.current = undefined;
    if (!mobile || !node || previousTop === undefined) return;
    node.dataset.dragging = "true";
    move(0);
    const naturalTop = node.getBoundingClientRect().top;
    move(previousTop - naturalTop);
    // Preserve the released position across the one layout change at a snap.
    void node.offsetHeight;
    resetDrag();
  }, [expanded, mobile]);

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
    "--book-navigation-bottom": mobile ? `max(0px, calc(64px + env(safe-area-inset-bottom) - ${viewport.bottom}px))` : "0px",
  } as CSSProperties;

  return <div className={`book-navigation-viewport ${mobile ? "book-navigation-viewport--mobile" : ""}`} style={viewportStyle}>
    <button type="button" aria-hidden="true" tabIndex={-1} onClick={onClose} className="book-navigation-backdrop" />
    <div className={mobile ? "book-navigation-sheet-clip" : undefined} style={mobile ? undefined : { display: "contents" }}>
    <aside ref={sheet} aria-label={label ?? (tab === "toc" ? "目录面板" : "全书搜索")} className={`book-navigation-sheet ${mobile ? "book-navigation-sheet--mobile" : "book-navigation-sheet--desktop"} ${compact ? "book-navigation-sheet--compact" : ""} ${panelClass}`} style={mobile ? { height: expanded ? "calc(100% - 48px)" : compact ? "auto" : "66%" } : undefined}>
      <div className="book-navigation-content">
      {mobile && <button type="button" aria-label="调整书内导航高度" aria-expanded={expanded} className="book-navigation-handle"
        onPointerDown={(event) => {
          if (event.button !== 0 || event.isPrimary === false) return;
          suppressPointerClick.current = false;
          const rect = sheet.current?.getBoundingClientRect();
          const transform = sheet.current ? getComputedStyle(sheet.current).transform : "none";
          const values = transform.slice(transform.indexOf("(") + 1, -1).split(",");
          const origin = transform.startsWith("matrix3d") ? Number(values[13]) : transform.startsWith("matrix(") ? Number(values[5]) : 0;
          gesture.current = { pointerId: event.pointerId, y: event.clientY, origin, height: rect?.height ?? 0, minimum: Math.min(0, viewport.top + 48 - ((rect?.top ?? viewport.top + 48) - origin)), lastY: event.clientY, time: event.timeStamp, velocity: 0, moved: false };
          move(origin);
          if (sheet.current) sheet.current.dataset.dragging = "true";
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const current = gesture.current;
          if (!current || current.pointerId !== event.pointerId) return;
          const distance = event.clientY - current.y;
          const elapsed = event.timeStamp - current.time;
          if (elapsed > 0) current.velocity = (event.clientY - current.lastY) / elapsed;
          current.lastY = event.clientY; current.time = event.timeStamp;
          if (Math.abs(distance) > 5) current.moved = true;
          move(Math.max(current.minimum, current.origin + distance));
        }}
        onPointerUp={(event) => {
          const current = gesture.current;
          if (!current || current.pointerId !== event.pointerId) return;
          const distance = event.clientY - current.y;
          const velocity = event.timeStamp - current.time < 80 ? current.velocity : 0;
          suppressPointerClick.current = current.moved || Math.abs(distance) > 5;
          gesture.current = undefined;
          const threshold = Math.min(120, Math.max(72, current.height * .18));
          if (distance > threshold || (distance > 12 && velocity > .65)) onClose();
          else if (distance < -48 || (distance < -12 && velocity < -.65)) changeExpanded(true);
          else resetDrag();
        }}
        onPointerCancel={() => { suppressPointerClick.current = true; resetDrag(); }}
        onLostPointerCapture={() => { if (gesture.current) { suppressPointerClick.current = true; resetDrag(); } }}
        onClick={(event) => { if (event.detail === 0 || !suppressPointerClick.current) changeExpanded(!expanded); suppressPointerClick.current = false; }}
        onKeyDown={(event) => { if (event.key === "ArrowUp") { event.preventDefault(); changeExpanded(true); } if (event.key === "ArrowDown") { event.preventDefault(); onClose(); } }}
      ><span aria-hidden="true" /></button>}
      <div className="book-navigation-toolbar">
        {tab ? <div role="tablist" aria-label="书内导航" className="book-navigation-tabs">
          {(["search", "toc"] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => onTabChange?.(value)}>{value === "search" ? "⌕ 搜本书" : "目录"}</button>)}
        </div> : <h2 className="book-tool-sheet-title">{title}</h2>}
        <button type="button" className="book-navigation-close" aria-label={tab ? "关闭书内导航" : `关闭${title}`} onClick={onClose}>×</button>
      </div>
      {children}
      </div>
    </aside>
    </div>
  </div>;
}
