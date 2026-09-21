/** Shared DOM helpers injected into reader WebViews: underlines are anchored by
 * absolute plain-text offsets, with prefix/suffix matching as the fallback when
 * stored offsets no longer line up. Used by both the book bridge and the Times
 * article document, so the two readers locate saved quotes identically. */
export const ANNOTATION_DOM_SCRIPT = `
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

      function wrapRange(root, id, start, end, attribute) {
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

      function unwrapMark(mark) {
        var parent = mark.parentNode;
        if (!parent) return;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
      }
`;
