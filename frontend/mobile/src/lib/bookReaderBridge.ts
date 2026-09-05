import { JOJO_BOOK_SEARCH_BLOCK_SELECTOR } from "@jojo/content";
import type { ReaderSelectionRect } from "@jojo/ui/reader-selection";

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
}

export interface BookReaderAnnotationMarker {
  id: string;
  start: number;
  end: number;
}

export interface BookReaderSelectionMessage {
  type: "reader-selection";
  text: string;
  start: number;
  end: number;
  rect?: ReaderSelectionRect;
  viewport?: { width: number; height: number };
}

export type BookReaderMessage =
  | { type: "reader-selection-clear" }
  | { type: "reader-tap" }
  | { type: "reader-boundary"; direction: "previous" | "next" }
  | { type: "reader-annotation"; id: string }
  | { type: "reader-internal-link"; chapterId: string; anchorId?: string }
  | { type: "reader-image"; assetId: string }
  | { type: "reader-cross-reference"; volumeNumber: number; chapterTitle: string; annotationLabel: string }
  | BookReaderSelectionMessage
  | BookReaderPageMessage;

export function createBookReaderGoToSpreadScript(index: number): string {
  const safeIndex = Math.max(0, Math.floor(Number.isFinite(index) ? index : 0));
  return `window.__jojoReaderGoToSpread && window.__jojoReaderGoToSpread(${safeIndex}); true;`;
}

export function createBookReaderGoToScrollProgressScript(progress: number): string {
  const safeProgress = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  return `window.__jojoReaderGoToScrollProgress && window.__jojoReaderGoToScrollProgress(${safeProgress}); true;`;
}

export function createBookReaderMeasureScript(): string {
  return "window.__jojoReaderMeasurePages && window.__jojoReaderMeasurePages(); true;";
}

function jsonArgument(value: unknown): string {
  return JSON.stringify(value).replaceAll("</", "<\\/");
}

export function createBookReaderLocateTextScript(text: string): string {
  return `window.__jojoReaderLocateText && window.__jojoReaderLocateText(${jsonArgument(text)}); true;`;
}

export function createBookReaderRevealAnchorScript(anchorId: string): string {
  return `window.__jojoReaderRevealAnchor && window.__jojoReaderRevealAnchor(${jsonArgument(anchorId)}); true;`;
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
    if (message.type === "reader-tap") return { type: "reader-tap" };
    if (message.type === "reader-annotation" && typeof message.id === "string" && message.id) {
      return { type: "reader-annotation", id: message.id };
    }
    if (message.type === "reader-internal-link" && typeof message.chapterId === "string" && message.chapterId) {
      return {
        type: "reader-internal-link",
        chapterId: message.chapterId,
        ...(typeof message.anchorId === "string" && message.anchorId ? { anchorId: message.anchorId } : {}),
      };
    }
    if (message.type === "reader-image" && typeof message.assetId === "string" && message.assetId) {
      return { type: "reader-image", assetId: message.assetId };
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
      && typeof message.start === "number"
      && typeof message.end === "number"
      && message.start >= 0
      && message.end > message.start) {
      const { rect, viewport } = message;
      const geometry = rect && viewport
        && [rect.left, rect.top, rect.right, rect.bottom, viewport.width, viewport.height].every(Number.isFinite)
        && rect.right > rect.left && rect.bottom > rect.top && viewport.width > 0 && viewport.height > 0
        ? { rect, viewport } : {};
      return { type: "reader-selection", text: message.text, start: message.start, end: message.end, ...geometry };
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
): string {
  return `
    (function () {
      var paged = document.body && document.body.dataset.readingMode === "paged";
      var startAtEnd = ${initialEdge === "end" ? "true" : "false"};
      var leftTapNext = ${leftTapNext ? "true" : "false"};
      var initialAnnotations = ${jsonArgument(annotations)};
      var currentSpread = 0;
      var spreadCount = 1;
      var pageCount = 1;
      var pagesPerSpread = 1;
      var touchStartX = 0;
      var touchStartY = 0;
      var selectionGesture = false;
      var lastSwipeAt = 0;
      var measureTimer = 0;
      var scrollTimer = 0;
      var restoreSpread = ${typeof initialSpreadIndex === "number" ? Math.max(0, Math.floor(initialSpreadIndex)) : "null"};
      var restoreScrollProgress = ${typeof initialScrollProgress === "number" ? Math.max(0, Math.min(1, initialScrollProgress)) : "null"};
      var restoreChapterProgress = ${typeof initialChapterProgress === "number" ? Math.max(0, Math.min(1, initialChapterProgress)) : "null"};
      var searchBlockSelector = ${jsonArgument(JOJO_BOOK_SEARCH_BLOCK_SELECTOR)};

      function attachSearchBlockAnchors() {
        var content = document.querySelector("[data-book-content]");
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
          window.ReactNativeWebView.postMessage(JSON.stringify(message));
        }
      }

      function isLink(target) {
        return !!(target && target.closest && target.closest("a"));
      }

      function articleRoot() {
        return document.querySelector("article");
      }

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

      function wrapRange(id, start, end, attribute) {
        var root = articleRoot();
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
        wrapRange(annotation.id, Number(annotation.start), Number(annotation.end), "data-annotation-id");
        scheduleMeasure();
      }

      function clearSelection() {
        var selection = window.getSelection && window.getSelection();
        if (selection) selection.removeAllRanges();
      }

      var lastSelection = "";
      function reportSelection() {
        var root = articleRoot();
        var selection = window.getSelection && window.getSelection();
        if (!root || !selection || selection.rangeCount < 1 || selection.isCollapsed) {
          if (lastSelection) post({ type: "reader-selection-clear" });
          lastSelection = "";
          return;
        }
        var range = selection.getRangeAt(0);
        if (!root.contains(range.commonAncestorContainer)) return;
        var raw = range.toString();
        var leading = raw.length - raw.trimStart().length;
        var text = raw.trim().slice(0, 800);
        if (!text) return;
        var start = absoluteOffset(root, range.startContainer, range.startOffset) + leading;
        var bounds = range.getBoundingClientRect();
        var visual = window.visualViewport;
        var viewport = { width: visual ? visual.width : window.innerWidth, height: visual ? visual.height : window.innerHeight };
        var offsetX = visual ? visual.offsetLeft : 0;
        var offsetY = visual ? visual.offsetTop : 0;
        var rect = { left: bounds.left - offsetX, top: bounds.top - offsetY, right: bounds.right - offsetX, bottom: bounds.bottom - offsetY };
        var key = start + ":" + text + ":" + JSON.stringify(rect) + ":" + JSON.stringify(viewport);
        if (key === lastSelection) return;
        lastSelection = key;
        post({ type: "reader-selection", text: text, start: start, end: start + text.length, rect: rect, viewport: viewport });
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
          scrollProgress: 0
        });
      }

      function reportScroll() {
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
          scrollProgress: progress
        });
      }

      function showSpread(index) {
        currentSpread = Math.max(0, Math.min(spreadCount - 1, index));
        var offset = currentSpread * window.innerWidth;
        var article = document.querySelector("article");
        if (article) {
          article.style.transform = "translate3d(" + (-offset) + "px, 0, 0)";
        }
        updateFooter();
        reportPage();
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
          if (restoreScrollProgress !== null || restoreChapterProgress !== null) {
            var progress = restoreScrollProgress !== null ? restoreScrollProgress : restoreChapterProgress;
            restoreScrollProgress = null;
            restoreChapterProgress = null;
            window.requestAnimationFrame(function () {
              var scrolling = document.scrollingElement || document.documentElement;
              window.scrollTo(0, Math.max(0, scrolling.scrollHeight - window.innerHeight) * progress);
              reportScroll();
            });
          } else {
            reportScroll();
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
      window.__jojoReaderGoToScrollProgress = function (progress) {
        if (paged) return;
        var scrolling = document.scrollingElement || document.documentElement;
        window.scrollTo(0, Math.max(0, scrolling.scrollHeight - window.innerHeight) * Math.max(0, Math.min(1, Number(progress) || 0)));
        reportScroll();
      };

      window.__jojoReaderApplyAnnotation = applyAnnotation;
      window.__jojoReaderClearSelection = clearSelection;
      window.__jojoReaderRevealAnchor = function (anchorId) {
        revealElement(document.getElementById(anchorId));
      };
      window.__jojoReaderRemoveAnnotation = function (id) {
        document.querySelectorAll('mark[data-annotation-id="' + CSS.escape(id) + '"]').forEach(function (mark) {
          mark.replaceWith(document.createTextNode(mark.textContent || ""));
        });
        var root = articleRoot();
        if (root) root.normalize();
        scheduleMeasure();
      };
      window.__jojoReaderLocateText = function (text) {
        var root = articleRoot();
        if (!root || !text) return;
        document.querySelectorAll("mark[data-search-target]").forEach(function (mark) {
          mark.replaceWith(document.createTextNode(mark.textContent || ""));
        });
        root.normalize();
        var source = root.textContent || "";
        var start = source.indexOf(text);
        if (start < 0) return;
        var target = wrapRange("active", start, start + text.length, "data-search-target");
        if (!target) return;
        revealElement(target);
      };

      initialAnnotations.slice().sort(function (a, b) { return b.start - a.start; }).forEach(applyAnnotation);

      document.addEventListener("touchstart", function (event) {
        selectionGesture = Boolean(window.getSelection && window.getSelection().toString());
        var touch = event.changedTouches[0];
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
      }, { passive: true });

      document.addEventListener("click", function (event) {
        // Android collapses the selection before click. Consume that dismissal
        // instead of also turning the page or opening a link underneath it.
        if (selectionGesture) { selectionGesture = false; return; }
        var image = event.target && event.target.closest && event.target.closest("img");
        var asset = image && image.closest && image.closest("[data-asset-id]");
        if (image && asset) {
          event.preventDefault();
          post({ type: "reader-image", assetId: asset.getAttribute("data-asset-id") || "" });
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
          var anchorId = decodeURIComponent((internalLink.getAttribute("href") || "").slice(1));
          var targetId = internalLink.getAttribute("data-target-id") || "";
          var target = anchorId ? document.getElementById(anchorId) : null;
          if (target) {
            revealElement(target);
          } else if (targetId) {
            post({ type: "reader-internal-link", chapterId: targetId, anchorId: anchorId });
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
        document.addEventListener("touchend", function (event) {
          if (selectionGesture || (window.getSelection && window.getSelection().toString())) { reportSelection(); return; }
          var touch = event.changedTouches[0];
          var dx = touch.clientX - touchStartX;
          var dy = touch.clientY - touchStartY;
          if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.25) {
            lastSwipeAt = Date.now();
            turn(dx < 0 ? "next" : "previous");
          } else {
            window.setTimeout(reportSelection, 80);
          }
        }, { passive: true });
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

      window.requestAnimationFrame(measurePages);
      window.setTimeout(measurePages, 240);
    })();
    true;
  `;
}
