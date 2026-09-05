import { positionReaderSelection, type ReaderSelectionRect } from "@jojo/ui/reader-selection";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export function BookSelectionPopover({ rect, width, children }: { rect: ReaderSelectionRect; width: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ width, height: 64, left: 0, top: 48, right: window.innerWidth, bottom: window.innerHeight - 16 });
  useLayoutEffect(() => {
    const measure = () => {
      const visual = window.visualViewport;
      const element = ref.current;
      setLayout({ width: element?.offsetWidth || width, height: element?.offsetHeight || 64,
        left: visual?.offsetLeft ?? 0, top: Math.max(48, visual?.offsetTop ?? 0),
        right: (visual?.offsetLeft ?? 0) + (visual?.width ?? window.innerWidth),
        bottom: (visual?.offsetTop ?? 0) + (visual?.height ?? window.innerHeight) - (window.innerWidth <= 768 ? 64 : 16) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); window.visualViewport?.removeEventListener("resize", measure); window.visualViewport?.removeEventListener("scroll", measure); };
  }, [width]);
  const position = positionReaderSelection(rect, layout, layout);
  return <div ref={ref} onPointerDown={(event) => { if ((event.target as Element).closest("button")) event.preventDefault(); }} className="book-selection-tools" data-side={position?.above ? "above" : "below"}
    style={{ width, left: position?.left, top: position?.top, visibility: position ? "visible" : "hidden", maxWidth: Math.max(0, layout.right - layout.left - 24), maxHeight: Math.max(64, layout.bottom - layout.top - 16) }}>
    {children}
    <span aria-hidden="true" className="book-selection-arrow" style={{ left: position?.arrowLeft }} />
  </div>;
}
