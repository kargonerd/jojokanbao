import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { isBetaChannel } from "../betaChannel";
import "./launch-commemoration.css";

const SEEN_KEY = "jojo:commemoration:1976-2026:seen";
const TURN_AT = 7000;
const COLOR_AT = 16000;
const END_AT = 26000;
// Keep the visual sequence and its pause/exit timers on the same timeline.
const TIMELINE_STYLE = {
  "--commemoration-turn-at": `${TURN_AT}ms`,
  "--commemoration-color-at": `${COLOR_AT}ms`,
  "--commemoration-end-at": `${END_AT}ms`,
} as CSSProperties;
// Editorial campaign dates, in Beijing time.
const START_AT = Date.parse("2026-09-01T00:00:00+08:00");
const CLOSE_AT = Date.parse("2026-10-01T00:00:00+08:00");
let seenInMemory = false;

function supportsModal() {
  return typeof window.HTMLDialogElement?.prototype.showModal === "function";
}

function shouldAutoPlay() {
  // Keep local development focused on reading, including after a refresh.
  if (import.meta.env.DEV) return false;
  if (isBetaChannel() || !supportsModal() || Date.now() < START_AT || Date.now() >= CLOSE_AT) return false;
  // Respect reduced motion without adding a permanent homepage entrance.
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return false;
  if (seenInMemory) return false;
  try {
    return !window.localStorage.getItem(SEEN_KEY);
  } catch {
    return false;
  }
}

function rememberVisit() {
  try {
    window.localStorage.setItem(SEEN_KEY, "1");
    seenInMemory = true;
    return true;
  } catch {
    // Do not replay on every reload if this browser cannot persist the visit.
    return false;
  }
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches));
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

function CommemorationFilm({ onClose }: { onClose: () => void }) {
  const reduced = useReducedMotion();
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  const elapsedRef = useRef(0);
  const renewalContentRef = useRef<HTMLDivElement>(null);
  const renewalDetailsRef = useRef<HTMLDivElement>(null);
  const complete = elapsed >= END_AT;
  const stopped = paused || hidden || reduced || complete;
  const renewed = elapsed >= TURN_AT;
  const colorStarted = elapsed >= COLOR_AT;

  useLayoutEffect(() => {
    const content = renewalContentRef.current;
    const details = renewalDetailsRef.current;
    if (!content || !details) return;
    // Measure the reserved space on resize; animate only the composited offset.
    const measure = () => {
      content.style.setProperty("--commemoration-quote-offset", `${details.getBoundingClientRect().height / 2}px`);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(details);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const previousTone = root.getAttribute("data-commemoration-tone");
    const previousPaused = root.getAttribute("data-commemoration-paused");
    return () => {
      if (previousTone === null) root.removeAttribute("data-commemoration-tone");
      else root.setAttribute("data-commemoration-tone", previousTone);
      if (previousPaused === null) root.removeAttribute("data-commemoration-paused");
      else root.setAttribute("data-commemoration-paused", previousPaused);
    };
  }, []);

  useLayoutEffect(() => {
    document.documentElement.dataset.commemorationTone = reduced ? "color" : colorStarted ? "renewal" : "memorial";
    document.documentElement.dataset.commemorationPaused = String(stopped);
  }, [colorStarted, reduced, stopped]);

  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    if (stopped) return;
    const started = performance.now();
    const milestone = [TURN_AT, COLOR_AT, END_AT].find((time) => time > elapsedRef.current) ?? END_AT;
    const timer = window.setTimeout(() => {
      elapsedRef.current = milestone;
      setElapsed(milestone);
    }, milestone - elapsedRef.current);
    return () => {
      window.clearTimeout(timer);
      elapsedRef.current = Math.min(milestone, elapsedRef.current + performance.now() - started);
    };
  }, [stopped, elapsed]);

  useEffect(() => {
    if (complete) onClose();
  }, [complete, onClose]);

  return (
    <div className="commemoration-film" style={TIMELINE_STYLE} data-renewed={renewed} data-paused={stopped} data-reduced={reduced} data-complete={complete}>
      <header className="commemoration-masthead">
        <span className="commemoration-wordmark">JOJO <span>看报</span></span>
        <button className="commemoration-text-button" type="button" onClick={onClose} autoFocus>跳过动画</button>
      </header>

      <div className="commemoration-stage">
        <section className="commemoration-renewal" aria-hidden={!renewed && !reduced}>
          <div ref={renewalContentRef} className="commemoration-renewal-content">
            <div className="commemoration-renewal-quote">
              <h2><span>雄关漫道真如铁，</span><span>而今迈步从头越。</span></h2>
              <cite className="commemoration-renewal-source">毛泽东《忆秦娥·娄山关》</cite>
            </div>
            <div ref={renewalDetailsRef} className="commemoration-renewal-details">
              <div className="commemoration-renewal-copy" aria-hidden={!colorStarted && !reduced}>
                <p><strong>JOJO 看报</strong><span>焕新升级</span></p>
              </div>
              <button className="commemoration-enter" type="button" onClick={onClose} aria-hidden={!colorStarted && !reduced} tabIndex={colorStarted || reduced ? 0 : -1}>进入新版 <span aria-hidden="true">↗</span></button>
            </div>
          </div>
        </section>

        <div className="commemoration-paper-stack" aria-hidden="true"><i /><i /></div>
        <section className="commemoration-paper" aria-hidden={renewed && !reduced}>
          <div className="commemoration-paper-body">
            <div className="commemoration-years">
              <div className="commemoration-fifty" aria-hidden="true">50</div>
              <span className="commemoration-years-label" aria-hidden="true">周 年</span>
              <p className="commemoration-year-range"><time dateTime="1976-09-09">1976</time><span>—</span><time dateTime="2026-09-09">2026</time></p>
            </div>
            <div className="commemoration-dedication">
              <h1 id="commemoration-title"><span>纪念毛主席</span><span>逝世五十周年</span></h1>
              <div className="commemoration-ink-line" />
              <blockquote className="commemoration-thought" cite="https://theory.people.com.cn/n1/2021/0727/c40531-32171877.html">
                <p><span>天若有情天亦老，</span><span>人间正道是沧桑。</span></p>
                <cite>毛泽东《七律·人民解放军占领南京》</cite>
              </blockquote>
            </div>
          </div>
        </section>
      </div>

      <footer className="commemoration-controls">
        <p className="commemoration-status" aria-live="polite">{reduced ? "纪念毛主席逝世五十周年 · JOJO 看报焕新升级" : renewed ? "焕新 · JOJO 看报" : "纪念 · 一九七六至二〇二六"}</p>
        {!reduced && <div className="commemoration-playback">
          <div className="commemoration-progress" aria-hidden="true"><i /></div>
          {!complete && <button type="button" className="commemoration-text-button" onClick={() => setPaused((value) => !value)}>{paused ? "继续播放" : "暂停动画"}</button>}
        </div>}
      </footer>
    </div>
  );
}

function CommemorationDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement;
    dialog.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      const focusTarget = previousFocus instanceof HTMLElement && previousFocus !== document.body && previousFocus.isConnected
        ? previousFocus
        : document.getElementById("app-home-search");
      focusTarget?.focus({ preventScroll: true });
    };
  }, []);

  return (
    <dialog ref={dialogRef} className="commemoration-dialog" aria-label="纪念毛主席逝世五十周年，JOJO 看报焕新开场" onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <CommemorationFilm onClose={onClose} />
    </dialog>
  );
}

export function LaunchCommemoration() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (shouldAutoPlay() && rememberVisit()) setOpen(true);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  // Keep reading available on older WebViews without native modal support.
  if (!supportsModal()) return null;

  return open ? <CommemorationDialog onClose={close} /> : null;
}
