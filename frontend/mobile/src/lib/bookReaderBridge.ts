import { JOJO_BOOK_SEARCH_BLOCK_SELECTOR } from "@jojo/content";
import type { SpeechLocation, SpeechReadingPosition } from "@jojo/content";
import { SPEECH_EXCLUDED_ELEMENTS } from "@jojo/content";
import { SPEECH_READER_FACTORY } from "@jojo/content/speech-dom-script";
import type { ReaderSelectionRect } from "@jojo/ui/reader-selection";
import { CONTINUOUS_BOOK_SCROLL_FACTORY, type ContinuousChapter } from "./continuousBookScroll";

export type BookReadingMode = "paged" | "scroll";
export type BookChapterEdge = "start" | "end";

export interface BookReaderPageMessage {
  type: "reader-page";
  paged: boolean;
  spreadIndex: number;
  spreadCount: number;
  pageStart: number;
  pageEnd: number;
  pageCount: number;
  pagesPerSpread: number;
  scrollProgress: number;
  anchorId?: string;
  chapterId?: string;
}

export interface BookReaderAnnotationMarker {
  id: string;
  chapterId?: string;
  start: number;
  end: number;
  quote?: string;
  prefix?: string;
  suffix?: string;
}

export interface BookReaderSelectionMessage {
  type: "reader-selection";
  chapterId?: string;
  text: string;
  prefix?: string;
  suffix?: string;
  start: number;
  end: number;
  rect?: ReaderSelectionRect;
  viewport?: { width: number; height: number };
}

export type BookReaderMessage =
  | { type: "reader-ready"; chapterId: string }
  | { type: "reader-speech-position"; requestId: number; position: SpeechReadingPosition }
  | { type: "reader-selection-clear" }
  | { type: "reader-tap" }
  | { type: "reader-boundary"; direction: "previous" | "next" }
  | { type: "reader-chapter-request"; chapterId: string }
  | { type: "reader-annotation"; id: string }
  | { type: "reader-internal-link"; chapterId: string; anchorId?: string; sourceChapterId?: string; sourceProgress?: number }
  | { type: "reader-image"; assetId: string; chapterId?: string }
  | { type: "reader-cross-reference"; volumeNumber: number; chapterTitle: string; annotationLabel: string }
  | BookReaderSelectionMessage
  | BookReaderPageMessage;

export function createBookReaderGoToSpreadScript(index: number): string {
  const safeIndex = Math.max(0, Math.floor(Number.isFinite(index) ? index : 0));
  return `window.__jojoReaderGoToSpread && window.__jojoReaderGoToSpread(${safeIndex}); true;`;
}

export function createBookReaderGoToScrollProgressScript(progress: number, chapterId?: string): string {
  const safeProgress = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  return `window.__jojoReaderGoToScrollProgress && window.__jojoReaderGoToScrollProgress(${safeProgress}${chapterId ? `, ${jsonArgument(chapterId)}` : ""}); true;`;
}

export function createBookReaderGoToChapterProgressScript(progress: number, chapterId?: string): string {
  const safeProgress = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  return `window.__jojoReaderGoToChapterProgress && window.__jojoReaderGoToChapterProgress(${safeProgress}${chapterId ? `, ${jsonArgument(chapterId)}` : ""}); true;`;
}

export function createBookReaderInsertChapterScript(chapterId: string, html: string, annotations: readonly BookReaderAnnotationMarker[]): string {
  return `window.__jojoReaderInsertChapter && window.__jojoReaderInsertChapter(${jsonArgument(chapterId)}, ${jsonArgument(html)}, ${jsonArgument(annotations)}); true;`;
}

export function createBookReaderChapterFailedScript(chapterId: string): string {
  return `window.__jojoReaderChapterFailed && window.__jojoReaderChapterFailed(${jsonArgument(chapterId)}); true;`;
}

export function createBookReaderMeasureScript(): string {
  return "window.__jojoReaderMeasurePages && window.__jojoReaderMeasurePages(); true;";
}

function jsonArgument(value: unknown): string {
  return JSON.stringify(value).replaceAll("</", "<\\/");
}

export function createBookReaderSpeechPositionScript(requestId: number): string {
  return `window.__jojoReaderSpeechPosition && window.__jojoReaderSpeechPosition(${jsonArgument(requestId)}); true;`;
}

export function createBookReaderSpeechHighlightScript(location: SpeechLocation | null, reveal = false): string {
  return `window.__jojoReaderSpeechHighlight && window.__jojoReaderSpeechHighlight(${jsonArgument(location)}, ${reveal}); true;`;
}

export function createBookReaderLocateTextScript(text: string, chapterId?: string): string {
  return `window.__jojoReaderLocateText && window.__jojoReaderLocateText(${jsonArgument(text)}${chapterId ? `, ${jsonArgument(chapterId)}` : ""}); true;`;
}

export function createBookReaderRevealAnchorScript(anchorId: string, chapterId?: string): string {
  return `window.__jojoReaderRevealAnchor && window.__jojoReaderRevealAnchor(${jsonArgument(anchorId)}${chapterId ? `, ${jsonArgument(chapterId)}` : ""}); true;`;
}

export function createBookReaderApplyAnnotationScript(annotation: BookReaderAnnotationMarker): string {
  return `window.__jojoReaderApplyAnnotation && window.__jojoReaderApplyAnnotation(${jsonArgument(annotation)}); true;`;
}

export function createBookReaderRemoveAnnotationScript(id: string): string {
  return `window.__jojoReaderRemoveAnnotation && window.__jojoReaderRemoveAnnotation(${jsonArgument(id)}); true;`;
}

export function createBookReaderClearSelectionScript(): string {
  return "window.__jojoReaderClearSelection && window.__jojoReaderClearSelection(); true;";
}

export function parseBookReaderMessage(value: string): BookReaderMessage | null {
  try {
    const message = JSON.parse(value) as Partial<BookReaderMessage>;
    if (message.type === "reader-ready" && typeof message.chapterId === "string" && message.chapterId) {
      return { type: "reader-ready", chapterId: message.chapterId };
    }
    if (message.type === "reader-speech-position" && Number.isInteger(message.requestId)
      && typeof message.position?.text === "string" && Number.isInteger(message.position.offset)
      && message.position.offset >= 0 && message.position.offset <= message.position.text.length) {
      return message as Extract<BookReaderMessage, { type: "reader-speech-position" }>;
    }
    if (message.type === "reader-tap") return { type: "reader-tap" };
    if (message.type === "reader-chapter-request" && typeof message.chapterId === "string" && message.chapterId) return { type: "reader-chapter-request", chapterId: message.chapterId };
    if (message.type === "reader-annotation" && typeof message.id === "string" && message.id) {
      return { type: "reader-annotation", id: message.id };
    }
    if (message.type === "reader-internal-link" && typeof message.chapterId === "string" && message.chapterId) {
      return {
        type: "reader-internal-link",
        chapterId: message.chapterId,
        ...(typeof message.anchorId === "string" && message.anchorId ? { anchorId: message.anchorId } : {}),
        ...(typeof message.sourceChapterId === "string" ? { sourceChapterId: message.sourceChapterId } : {}),
        ...(typeof message.sourceProgress === "number" && Number.isFinite(message.sourceProgress) ? { sourceProgress: message.sourceProgress } : {}),
      };
    }
    if (message.type === "reader-image" && typeof message.assetId === "string" && message.assetId) {
      return { type: "reader-image", assetId: message.assetId, ...(typeof message.chapterId === "string" ? { chapterId: message.chapterId } : {}) };
    }
    if (message.type === "reader-cross-reference"
      && typeof message.volumeNumber === "number"
      && Number.isInteger(message.volumeNumber)
      && message.volumeNumber > 0
      && typeof message.chapterTitle === "string"
      && message.chapterTitle
      && typeof message.annotationLabel === "string"
      && message.annotationLabel) {
      return message as Extract<BookReaderMessage, { type: "reader-cross-reference" }>;
    }
    if (message.type === "reader-selection-clear") return { type: "reader-selection-clear" };
    if (message.type === "reader-selection"
      && typeof message.text === "string"
      && message.text.trim()
      && message.text.length <= 4000
      && typeof message.start === "number"
      && typeof message.end === "number"
      && message.start >= 0
      && message.end > message.start) {
      if ((message.prefix !== undefined && (typeof message.prefix !== "string" || message.prefix.length > 80))
        || (message.suffix !== undefined && (typeof message.suffix !== "string" || message.suffix.length > 80))) return null;
      const { rect, viewport } = message;
      const geometry = rect && viewport
        && [rect.left, rect.top, rect.right, rect.bottom, viewport.width, viewport.height].every(Number.isFinite)
        && rect.right > rect.left && rect.bottom > rect.top && viewport.width > 0 && viewport.height > 0
        ? { rect, viewport } : {};
      return { type: "reader-selection", text: message.text, start: message.start, end: message.end, ...(typeof message.prefix === "string" ? { prefix: message.prefix } : {}), ...(typeof message.suffix === "string" ? { suffix: message.suffix } : {}), ...(typeof message.chapterId === "string" ? { chapterId: message.chapterId } : {}), ...geometry };
    }
    if (message.type === "reader-boundary" && (message.direction === "previous" || message.direction === "next")) {
      return { type: "reader-boundary", direction: message.direction };
    }
    if (message.type === "reader-page"
      && typeof message.paged === "boolean"
      && typeof message.spreadIndex === "number"
      && typeof message.spreadCount === "number"
      && typeof message.pageStart === "number"
      && typeof message.pageEnd === "number"
      && typeof message.pageCount === "number"
      && typeof message.pagesPerSpread === "number"
      && (message.scrollProgress === undefined || typeof message.scrollProgress === "number")) {
      return {
        ...message,
        scrollProgress: typeof message.scrollProgress === "number" ? message.scrollProgress : 0,
      } as BookReaderPageMessage;
    }
  } catch {
    // Reader messages are optional UI events; malformed values are ignored.
  }
  return null;
}

export function createBookReaderBridgeScript(
  initialEdge: BookChapterEdge,
  leftTapNext = false,
  annotations: readonly BookReaderAnnotationMarker[] = [],
  initialSpreadIndex?: number,
  initialScrollProgress?: number,
  initialChapterProgress?: number,
  navigation: { tocAnchorIds?: string[]; hasNext?: boolean; hasPrevious?: boolean; eInk?: boolean; chapters?: ContinuousChapter[]; initialChapterId?: string } = {},
): string {
  return `
    (function () {
      if (!document.body || !document.querySelector("article")) return;
      var documentChapterId = ${jsonArgument(navigation.initialChapterId ?? "")};
      function reportReady() {
        var content = document.querySelector("[data-book-content]");
        var chapterId = documentChapterId || (content && content.getAttribute("data-target-id"));
        if (chapterId) post({ type: "reader-ready", chapterId: chapterId });
      }
      if (window.__jojoBookReaderInitialized) {
        reportReady();
        if (window.__jojoReaderMeasurePages) window.__jojoReaderMeasurePages();
        return;
      }
      var paged = document.body && document.body.dataset.readingMode === "paged";
      var continuous = null;
      var startAtEnd = ${initialEdge === "end" ? "true" : "false"};
      var leftTapNext = ${leftTapNext ? "true" : "false"};
      var initialAnnotations = ${jsonArgument(annotations)};
      var currentSpread = 0;
      var spreadCount = 1;
      var pageCount = 1;
      var pagesPerSpread = 1;
      var touchStartX = 0;
      var touchStartY = 0;
      var touchStartAt = 0;
      var draggingPage = false;
      var touchInteractive = false;
      var touchGestureCancelled = false;
      var tocAnchorIds = ${jsonArgument(navigation.tocAnchorIds ?? [])};
      var reduceMotion = ${navigation.eInk ? "true" : "false"} || Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      var selectionGesture = false;
      var lastSwipeAt = 0;
      var measureTimer = 0;
      var scrollTimer = 0;
      var pageReportTimer = 0;
      var restoreSpread = ${typeof initialSpreadIndex === "number" ? Math.max(0, Math.floor(initialSpreadIndex)) : "null"};
      var restoreScrollProgress = ${typeof initialScrollProgress === "number" ? Math.max(0, Math.min(1, initialScrollProgress)) : "null"};
      var restoreChapterProgress = ${typeof initialChapterProgress === "number" ? Math.max(0, Math.min(1, initialChapterProgress)) : "null"};
      var searchBlockSelector = ${jsonArgument(JOJO_BOOK_SEARCH_BLOCK_SELECTOR)};

      function attachSearchBlockAnchors(root) {
        var content = (root || document).querySelector("[data-book-content]");
        if (!content) return;
        var targetId = content.getAttribute("data-target-id") || "chapter";
        var blockNumber = 0;
        content.querySelectorAll(searchBlockSelector).forEach(function (element) {
          if (element.parentElement && element.parentElement.closest(searchBlockSelector)) return;
          if (!(element.textContent || "").normalize("NFKC").replace(/\\s+/g, " ").trim()) return;
          blockNumber += 1;
          if (!element.id) element.id = "jojo-search-block:" + targetId + ":" + blockNumber;
        });
      }

      attachSearchBlockAnchors();

      function post(message) {
        if (window.ReactNativeWebView) {
          if (window.__jojoReaderSessionId) message.readerSessionId = window.__jojoReaderSessionId;
          window.ReactNativeWebView.postMessage(JSON.stringify(message));
        }
      }

      function isLink(target) {
        return !!(target && target.closest && target.closest("a"));
      }

      function articleRoot(chapterId) {
        return continuous ? continuous.root(chapterId) : document.querySelector("article");
      }

      function chapterOf(node) {
        var element = node && (node.nodeType === 1 ? node : node.parentElement);
        var root = element && element.closest && element.closest("article");
        return root && (root.getAttribute("data-reader-chapter-id") || documentChapterId);
      }

      function findAnchor(anchorId, chapterId) {
        var root = articleRoot(chapterId);
        if (continuous) return continuous.findAnchor(chapterId || continuous.current().chapterId, anchorId);
        return document.getElementById(anchorId) || (root && Array.from(root.querySelectorAll("[id]")).find(function (element) { return element.id === anchorId || element.getAttribute("data-reader-anchor-id") === anchorId; }));
      }

      function postInternalLink(targetId, anchorId, sourceChapterId) {
        var position = continuous && continuous.position(sourceChapterId);
        post({ type: "reader-internal-link", chapterId: targetId, anchorId: anchorId, sourceChapterId: sourceChapterId || undefined, sourceProgress: position ? position.progress : undefined });
      }

      var speechReader = null;
      var speechRoot = null;
      var speechBottomInset = 80;
      function ensureSpeechReader(chapterId) {
        var root = articleRoot(chapterId);
        if (root && root !== speechRoot) {
          speechRoot = root;
          speechReader = ${SPEECH_READER_FACTORY}(root, function () {
            return { left: 0, top: 64, right: window.innerWidth, bottom: window.innerHeight - speechBottomInset };
          }, ${jsonArgument(SPEECH_EXCLUDED_ELEMENTS)});
        }
        return root ? speechReader : null;
      }
      window.__jojoReaderSpeechPosition = function (requestId) {
        speechBottomInset = 80;
        if (ensureSpeechReader()) post({ type: "reader-speech-position", requestId: requestId, position: speechReader.read() });
      };
      window.__jojoReaderSpeechHighlight = function (location, reveal) {
        if (!location) return;
        var root = articleRoot(location.chapterId);
        if (!root || chapterOf(root) !== location.chapterId || !ensureSpeechReader(location.chapterId)) return;
        speechBottomInset = 128;
        speechReader.show(location.segments, location.index, reveal ? function (range) {
          var rect = range.getClientRects()[0];
          if (!rect) return;
          if (paged) showSpread(Math.floor((Math.max(0, rect.left + currentSpread * window.innerWidth) + 1) / Math.max(1, window.innerWidth)));
          else if (rect.top < 80 || rect.bottom > window.innerHeight - 128) window.scrollTo(0, window.scrollY + rect.top - 80);
        } : undefined);
      };

      function textNodes(root) {
        var nodes = [];
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        var node;
        while ((node = walker.nextNode())) nodes.push(node);
        return nodes;
      }

      function absoluteOffset(root, node, offset) {
        var range = document.createRange();
        range.selectNodeContents(root);
        range.setEnd(node, offset);
        return range.toString().length;
      }

      function wrapRange(id, start, end, attribute, chapterId) {
        var root = articleRoot(chapterId);
        if (!root || start < 0 || end <= start) return null;
        var cursor = 0;
        var firstMark = null;
        textNodes(root).forEach(function (node) {
          var length = node.nodeValue ? node.nodeValue.length : 0;
          var nodeStart = cursor;
          var nodeEnd = cursor + length;
          cursor = nodeEnd;
          if (nodeEnd <= start || nodeStart >= end || !node.parentNode) return;
          if (node.parentElement && node.parentElement.closest("mark[" + attribute + "]")) return;
          var range = document.createRange();
          range.setStart(node, Math.max(0, start - nodeStart));
          range.setEnd(node, Math.min(length, end - nodeStart));
          var mark = document.createElement("mark");
          mark.setAttribute(attribute, id);
          try {
            range.surroundContents(mark);
            if (!firstMark) firstMark = mark;
          } catch (_) {}
        });
        return firstMark;
      }

      function applyAnnotation(annotation) {
        if (!annotation || !annotation.id || document.querySelector('mark[data-annotation-id="' + CSS.escape(annotation.id) + '"]')) return;
        var root = articleRoot(annotation.chapterId);
        if (!root) return;
        var start = Number(annotation.start);
        var end = Number(annotation.end);
        if (typeof annotation.quote === "string") {
          if (!annotation.quote) return;
          var source = root.textContent || "";
          if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || source.slice(start, end) !== annotation.quote) {
            var located = locateAnnotationQuote(source, annotation.quote, annotation.prefix, annotation.suffix, start);
            if (located < 0) return;
            start = located;
            end = start + annotation.quote.length;
          }
        }
        if (!Number.isInteger(start) || !Number.isInteger(end)) return;
        wrapRange(annotation.id, start, end, "data-annotation-id", annotation.chapterId);
        scheduleMeasure();
      }

      function locateAnnotationQuote(source, quote, prefix, suffix, preferredOffset) {
        var before = typeof prefix === "string" ? prefix.slice(-80) : "";
        var after = typeof suffix === "string" ? suffix.slice(0, 80) : "";
        var preferred = Number.isFinite(preferredOffset) && preferredOffset >= 0 ? preferredOffset : 0;
        var best = -1;
        var bestScore = -1;
        var bestDistance = Infinity;
        for (var index = source.indexOf(quote); index >= 0; index = source.indexOf(quote, index + 1)) {
          var score = 0;
          for (var left = 1; left <= before.length && index >= left; left += 1) {
            if (before.charAt(before.length - left) !== source.charAt(index - left)) break;
            score += 1;
          }
          for (var right = 0; right < after.length && index + quote.length + right < source.length; right += 1) {
            if (after.charAt(right) !== source.charAt(index + quote.length + right)) break;
            score += 1;
          }
          var distance = Math.abs(index - preferred);
          if (score > bestScore || (score === bestScore && distance < bestDistance)) {
            best = index; bestScore = score; bestDistance = distance;
          }
        }
        return best;
      }

      function clearSelection() {
        var selection = window.getSelection && window.getSelection();
        if (selection) selection.removeAllRanges();
      }

      var lastSelection = "";
      function reportSelection() {
        var selection = window.getSelection && window.getSelection();
        if (!selection || selection.rangeCount < 1 || selection.isCollapsed) {
          if (lastSelection) post({ type: "reader-selection-clear" });
          lastSelection = "";
          return;
        }
        var range = selection.getRangeAt(0);
        var chapterId = chapterOf(range.startContainer);
        var root = articleRoot(chapterId);
        if (!root || !root.contains(range.commonAncestorContainer)) { clearSelection(); post({ type: "reader-selection-clear" }); lastSelection = ""; return; }
        var raw = range.toString();
        var leading = raw.length - raw.trimStart().length;
        var text = raw.trim();
        if (!text || text.length > 4000) {
          lastSelection = "";
          post({ type: "reader-selection-clear" });
          return;
        }
        var start = absoluteOffset(root, range.startContainer, range.startOffset) + leading;
        var source = root.textContent || "";
        var prefix = source.slice(Math.max(0, start - 80), start);
        var suffix = source.slice(start + text.length, start + text.length + 80);
        var bounds = range.getBoundingClientRect();
        var visual = window.visualViewport;
        var viewport = { width: visual ? visual.width : window.innerWidth, height: visual ? visual.height : window.innerHeight };
        var offsetX = visual ? visual.offsetLeft : 0;
        var offsetY = visual ? visual.offsetTop : 0;
        var rect = { left: bounds.left - offsetX, top: bounds.top - offsetY, right: bounds.right - offsetX, bottom: bounds.bottom - offsetY };
        var key = chapterId + ":" + start + ":" + text + ":" + JSON.stringify(rect) + ":" + JSON.stringify(viewport);
        if (key === lastSelection) return;
        lastSelection = key;
        post({ type: "reader-selection", chapterId: chapterId, text: text, start: start, end: start + text.length, prefix: prefix, suffix: suffix, rect: rect, viewport: viewport });
      }

      function ensureFooter() {
        var footer = document.getElementById("jojo-page-footer");
        if (footer) return footer;
        footer = document.createElement("div");
        footer.id = "jojo-page-footer";
        footer.setAttribute("aria-hidden", "true");
        footer.innerHTML = "<span></span><span></span>";
        document.body.appendChild(footer);
        return footer;
      }

      function updateFooter() {
        if (!paged) return;
        var footer = ensureFooter();
        var first = currentSpread * pagesPerSpread + 1;
        var last = Math.min(pageCount, first + pagesPerSpread - 1);
        var labels = footer.querySelectorAll("span");
        footer.style.gridTemplateColumns = pagesPerSpread === 2 ? "1fr 1fr" : "1fr";
        labels[0].textContent = first + " / " + pageCount;
        labels[1].textContent = pagesPerSpread === 2 && last > first ? last + " / " + pageCount : "";
        labels[1].style.display = pagesPerSpread === 2 ? "block" : "none";
      }

      function reportPage() {
        var pageStart = currentSpread * pagesPerSpread + 1;
        post({
          type: "reader-page",
          paged: paged,
          spreadIndex: currentSpread,
          spreadCount: spreadCount,
          pageStart: pageStart,
          pageEnd: Math.min(pageCount, pageStart + pagesPerSpread - 1),
          pageCount: pageCount,
          pagesPerSpread: pagesPerSpread,
          scrollProgress: 0,
          anchorId: currentTocAnchor()
        });
      }

      function reportScroll() {
        var position = continuous && continuous.current();
        var scrolling = document.scrollingElement || document.documentElement;
        var maximum = Math.max(0, scrolling.scrollHeight - window.innerHeight);
        var progress = maximum > 0 ? Math.max(0, Math.min(1, scrolling.scrollTop / maximum)) : 0;
        post({
          type: "reader-page",
          paged: false,
          spreadIndex: 0,
          spreadCount: 1,
          pageStart: 1,
          pageEnd: 1,
          pageCount: 1,
          pagesPerSpread: 1,
          chapterId: position ? position.chapterId : documentChapterId,
          scrollProgress: position ? position.progress : progress,
          anchorId: currentTocAnchor()
        });
      }

      function currentTocAnchor() {
        var current;
        var position = continuous && continuous.current();
        (position ? continuous.anchors(position.chapterId) : tocAnchorIds).forEach(function (id) {
          var target = findAnchor(id, position && position.chapterId);
          if (!target) return;
          var rect = target.getBoundingClientRect();
          if (paged ? rect.left < window.innerWidth && rect.top < window.innerHeight : rect.top < window.innerHeight * .4) current = id;
        });
        return current;
      }

      function showSpread(index, animate) {
        window.clearTimeout(pageReportTimer);
        currentSpread = Math.max(0, Math.min(spreadCount - 1, index));
        var offset = currentSpread * window.innerWidth;
        var article = document.querySelector("article");
        if (article) {
          article.style.transition = animate && !reduceMotion ? "transform 180ms ease-out" : "none";
          article.style.transform = "translate3d(" + (-offset) + "px, 0, 0)";
        }
        updateFooter();
        reportPage();
        // CSS transitions still expose the previous coordinates on this frame.
        // Refresh the active TOC anchor once the destination is actually visible.
        if (animate && !reduceMotion) pageReportTimer = window.setTimeout(reportPage, 200);
      }

      function revealElement(target) {
        if (!target) return;
        document.querySelectorAll("[data-book-jump-target]").forEach(function (element) {
          element.removeAttribute("data-book-jump-target");
        });
        if (paged) {
          var rect = target.getClientRects()[0] || target.getBoundingClientRect();
          var absoluteLeft = rect.left + currentSpread * window.innerWidth;
          showSpread(Math.floor((Math.max(0, absoluteLeft) + 1) / Math.max(1, window.innerWidth)));
        } else {
          target.scrollIntoView({ block: "center" });
        }
        target.setAttribute("data-book-jump-target", "true");
        window.setTimeout(function () { target.removeAttribute("data-book-jump-target"); }, 2200);
      }

      function measurePages() {
        if (!paged) {
          if (startAtEnd) { restoreScrollProgress = 1; startAtEnd = false; }
          if (restoreScrollProgress !== null || restoreChapterProgress !== null) {
            var progress = restoreScrollProgress !== null ? restoreScrollProgress : restoreChapterProgress;
            restoreScrollProgress = null;
            restoreChapterProgress = null;
            window.requestAnimationFrame(function () {
              if (continuous) continuous.seek(documentChapterId, progress);
              else {
                var scrolling = document.scrollingElement || document.documentElement;
                window.scrollTo(0, Math.max(0, scrolling.scrollHeight - window.innerHeight) * progress);
              }
              if (continuous) continuous.start();
              reportScroll();
            });
          } else {
            reportScroll();
            if (continuous) continuous.start();
          }
          return;
        }
        var oldPageStart = currentSpread * pagesPerSpread;
        pagesPerSpread = window.matchMedia("(orientation: landscape) and (min-width: 900px)").matches ? 2 : 1;
        var viewport = Math.max(1, window.innerWidth);
        var article = document.querySelector("article");
        var contentWidth = Math.max(
          viewport,
          document.documentElement.scrollWidth,
          document.body.scrollWidth,
          article ? article.scrollWidth : 0
        );
        pageCount = Math.max(1, Math.ceil((contentWidth / (viewport / pagesPerSpread)) - 0.02));
        spreadCount = Math.max(1, Math.ceil(pageCount / pagesPerSpread));
        if (startAtEnd) {
          currentSpread = spreadCount - 1;
          startAtEnd = false;
          restoreSpread = null;
        } else if (restoreSpread !== null) {
          currentSpread = Math.min(spreadCount - 1, restoreSpread);
          restoreSpread = null;
        } else if (restoreChapterProgress !== null) {
          currentSpread = Math.min(spreadCount - 1, Math.floor(restoreChapterProgress * spreadCount));
          restoreChapterProgress = null;
        } else {
          currentSpread = Math.min(spreadCount - 1, Math.floor(oldPageStart / pagesPerSpread));
        }
        showSpread(currentSpread);
      }

      function scheduleMeasure() {
        window.clearTimeout(measureTimer);
        measureTimer = window.setTimeout(measurePages, 80);
      }

      window.__jojoReaderMeasurePages = scheduleMeasure;

      function turn(direction) {
        var next = currentSpread + (direction === "next" ? 1 : -1);
        if (next < 0 || next >= spreadCount) {
          post({ type: "reader-boundary", direction: direction });
          return;
        }
        showSpread(next);
      }

      window.__jojoReaderGoToSpread = function (index) {
        if (!paged) return;
        showSpread(Number(index) || 0);
      };
      window.__jojoReaderGoToScrollProgress = function (progress, chapterId) {
        if (paged) return;
        if (continuous) { continuous.seek(chapterId || continuous.current().chapterId, Number(progress) || 0); return; }
        var scrolling = document.scrollingElement || document.documentElement;
        window.scrollTo(0, Math.max(0, scrolling.scrollHeight - window.innerHeight) * Math.max(0, Math.min(1, Number(progress) || 0)));
        reportScroll();
      };
      window.__jojoReaderGoToChapterProgress = function (progress, chapterId) {
        var value = Math.max(0, Math.min(1, Number(progress) || 0));
        if (paged) showSpread(Math.min(spreadCount - 1, Math.floor(value * spreadCount)));
        else window.__jojoReaderGoToScrollProgress(value, chapterId);
      };

      window.__jojoReaderApplyAnnotation = applyAnnotation;
      window.__jojoReaderClearSelection = clearSelection;
      window.__jojoReaderRevealAnchor = function (anchorId, chapterId) {
        revealElement(findAnchor(anchorId, chapterId));
      };
      window.__jojoReaderRemoveAnnotation = function (id) {
        document.querySelectorAll('mark[data-annotation-id="' + CSS.escape(id) + '"]').forEach(function (mark) {
          mark.replaceWith(document.createTextNode(mark.textContent || ""));
        });
        var root = articleRoot();
        if (root) root.normalize();
        scheduleMeasure();
      };
      window.__jojoReaderLocateText = function (text, chapterId) {
        var root = articleRoot(chapterId);
        if (!root || !text) return;
        document.querySelectorAll("mark[data-search-target]").forEach(function (mark) {
          mark.replaceWith(document.createTextNode(mark.textContent || ""));
        });
        root.normalize();
        var source = root.textContent || "";
        var start = source.indexOf(text);
        if (start < 0) return;
        var target = wrapRange("active", start, start + text.length, "data-search-target", chapterId);
        if (!target) return;
        revealElement(target);
      };

      function prepareChapter(root, annotations) {
        attachSearchBlockAnchors(root);
        annotations.slice().sort(function (a, b) { return b.start - a.start; }).forEach(applyAnnotation);
      }
      if (!paged && ${Boolean(navigation.chapters?.length)}) {
        continuous = (${CONTINUOUS_BOOK_SCROLL_FACTORY})(${jsonArgument(navigation.chapters ?? [])}, documentChapterId, post, prepareChapter, reportScroll);
      }
      window.__jojoReaderInsertChapter = function (chapterId, html, annotations) { if (continuous) continuous.insert(chapterId, html, annotations); };
      window.__jojoReaderChapterFailed = function (chapterId) { if (continuous) continuous.fail(chapterId); };
      initialAnnotations.slice().sort(function (a, b) { return b.start - a.start; }).forEach(applyAnnotation);

      document.addEventListener("touchstart", function (event) {
        selectionGesture = Boolean(window.getSelection && window.getSelection().toString());
        var touch = event.changedTouches[0];
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
        touchStartAt = Date.now();
        if (draggingPage) showSpread(currentSpread);
        draggingPage = false;
        touchGestureCancelled = Boolean(event.touches && event.touches.length !== 1);
        touchInteractive = Boolean(event.target && event.target.closest && event.target.closest("a, button, input"));

      }, { passive: true });

      document.addEventListener("click", function (event) {
        // Android collapses the selection before click. Consume that dismissal
        // instead of also turning the page or opening a link underneath it.
        if (selectionGesture) { selectionGesture = false; return; }
        var image = event.target && event.target.closest && event.target.closest("img");
        var asset = image && image.closest && image.closest("[data-asset-id]");
        if (image && asset) {
          event.preventDefault();
          post({ type: "reader-image", chapterId: chapterOf(asset), assetId: asset.getAttribute("data-asset-id") || "" });
          return;
        }
        var annotation = event.target && event.target.closest && event.target.closest("mark[data-annotation-id]");
        if (annotation) {
          post({ type: "reader-annotation", id: annotation.getAttribute("data-annotation-id") || "" });
          return;
        }
        var internalLink = event.target && event.target.closest && event.target.closest('a[href^="#"]');
        if (internalLink) {
          event.preventDefault();
          var referenceVolume = Number(internalLink.getAttribute("data-reference-volume"));
          var referenceChapter = internalLink.getAttribute("data-reference-chapter") || "";
          var referenceLabel = internalLink.getAttribute("data-reference-label") || "";
          if (referenceVolume > 0 && referenceChapter && referenceLabel) {
            post({ type: "reader-cross-reference", volumeNumber: referenceVolume, chapterTitle: referenceChapter, annotationLabel: referenceLabel });
            return;
          }
          var anchorId = internalLink.getAttribute("data-reader-href-anchor-id") || decodeURIComponent((internalLink.getAttribute("href") || "").slice(1));
          var targetId = internalLink.getAttribute("data-target-id") || "";
          if (targetId && targetId !== chapterOf(internalLink)) { postInternalLink(targetId, anchorId, chapterOf(internalLink)); return; }
          var target = anchorId ? findAnchor(anchorId, chapterOf(internalLink)) : null;
          if (target) {
            revealElement(target);
          } else if (targetId) {
            postInternalLink(targetId, anchorId, chapterOf(internalLink));
          }
          return;
        }
        if (Date.now() - lastSwipeAt < 400 || isLink(event.target)) return;
        if (window.getSelection && window.getSelection().toString()) return;
        var x = event.clientX / window.innerWidth;
        var y = event.clientY / window.innerHeight;
        if (paged && x < 0.24) {
          turn(leftTapNext ? "next" : "previous");
        } else if (paged && x > 0.76) {
          turn(leftTapNext ? "previous" : "next");
        } else if (x > 0.24 && x < 0.76 && y > 0.12 && y < 0.88) {
          post({ type: "reader-tap" });
        }
      });

      if (paged) {
        document.addEventListener("touchmove", function (event) {
          if (event.touches.length !== 1) touchGestureCancelled = true;
          if (touchGestureCancelled || selectionGesture || touchInteractive || (window.getSelection && window.getSelection().toString())) {
            if (draggingPage) { showSpread(currentSpread); draggingPage = false; }
            return;
          }
          if (!draggingPage && Date.now() - touchStartAt > 450) return;
          var touch = event.changedTouches[0];
          var dx = touch.clientX - touchStartX;
          var dy = touch.clientY - touchStartY;
          if (!draggingPage && (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.25)) return;
          draggingPage = true;
          event.preventDefault();
          var article = articleRoot();
          if (!article || reduceMotion) return;
          var boundary = (currentSpread === 0 && dx > 0) || (currentSpread === spreadCount - 1 && dx < 0);
          var offset = -currentSpread * window.innerWidth + (boundary ? dx * .25 : dx);
          article.style.transition = "none";
          article.style.transform = "translate3d(" + offset + "px, 0, 0)";
        }, { passive: false });
        document.addEventListener("touchend", function (event) {
          if (touchGestureCancelled || selectionGesture || touchInteractive || (window.getSelection && window.getSelection().toString())) { if (draggingPage) showSpread(currentSpread); reportSelection(); return; }
          var touch = event.changedTouches[0];
          var dx = touch.clientX - touchStartX;
          var dy = touch.clientY - touchStartY;
          var quickSwipe = Math.abs(dx) > 24 && Date.now() - touchStartAt < 250;
          if ((draggingPage || Date.now() - touchStartAt < 450) && (Math.abs(dx) > Math.min(90, window.innerWidth * .2) || quickSwipe) && Math.abs(dx) > Math.abs(dy) * 1.25) {
            lastSwipeAt = Date.now();
            var next = currentSpread + (dx < 0 ? 1 : -1);
            if (next >= 0 && next < spreadCount) showSpread(next, true);
            else { showSpread(currentSpread, true); turn(dx < 0 ? "next" : "previous"); }
          } else {
            if (draggingPage) { lastSwipeAt = Date.now(); showSpread(currentSpread, true); }
            window.setTimeout(reportSelection, 80);
          }
        }, { passive: true });
        document.addEventListener("touchcancel", function () { if (draggingPage) showSpread(currentSpread, true); draggingPage = false; }, { passive: true });
        window.addEventListener("resize", scheduleMeasure);
        document.querySelectorAll("img").forEach(function (image) {
          if (!image.complete) image.addEventListener("load", scheduleMeasure, { once: true });
        });
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleMeasure);
      }

      document.addEventListener("mouseup", function () { window.setTimeout(reportSelection, 0); });
      document.addEventListener("selectionchange", reportSelection);
      document.addEventListener("contextmenu", function (event) { event.preventDefault(); reportSelection(); });
      window.addEventListener("resize", reportSelection);
      if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", reportSelection);
        window.visualViewport.addEventListener("scroll", reportSelection);
      }
      if (!paged) {
        document.addEventListener("scroll", function () {
          window.clearTimeout(scrollTimer);
          scrollTimer = window.setTimeout(function () { reportScroll(); reportSelection(); }, 90);
        }, { passive: true });
      }

      window.__jojoBookReaderInitialized = true;
      reportReady();
      window.requestAnimationFrame(measurePages);
      window.setTimeout(measurePages, 240);
    })();
    true;
  `;
}
