/* Appable edit bridge - auto-generated, do not edit. v14 */
/* eslint-disable */
if (
  typeof document !== "undefined" &&
  typeof window !== "undefined" &&
  window.parent !== window
) {
  (function hidePreviewScrollbars() {
    if (document.querySelector("[data-appable=hide-scrollbars]")) return;
    var style = document.createElement("style");
    style.setAttribute("data-appable", "hide-scrollbars");
    style.textContent =
      "html,body{scrollbar-width:none!important;-ms-overflow-style:none!important}" +
      "html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}" +
      "*{scrollbar-width:none!important;-ms-overflow-style:none!important}" +
      "*::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}";
    (document.head || document.documentElement).appendChild(style);
  })();

  var editMode = false;
  var lastHighlight = null;
  var lastOutline = "";
  var lastPartEls = [];
  var lastPartIsIcon = [];
  var lastStyleEl = null;
  var lastBgEl = null;

  var BROAD_TEST_IDS = {
    screen: 1,
    scroll: 1,
    scrollview: 1,
    root: 1,
    layout: 1,
    wrapper: 1,
    container: 1,
    page: 1,
    app: 1,
    content: 1,
    section: 1,
    header: 1,
    "home-screen": 1,
    "home-scroll": 1,
    "home-root": 1,
    "home-layout": 1,
    "home-wrapper": 1,
    "home-container": 1,
    "home-page": 1,
    "home-content": 1,
    "home-section": 1,
    "home-header": 1,
  };

  function isBroadTestId(id) {
    if (!id) return true;
    var lower = String(id).toLowerCase();
    if (BROAD_TEST_IDS[lower]) return true;
    if (/^home-(screen|scroll|root|layout|wrapper|container|page|content|section|header)/.test(lower)) {
      return true;
    }
    if (/-(screen|scrollview|scroll-view|root|layout|wrapper|container|page)$/.test(lower)) {
      return true;
    }
    return false;
  }

  function testIdOn(el) {
    return el && el.getAttribute ? el.getAttribute("data-testid") : null;
  }

  function isNonEditable(el) {
    var cur = el;
    var steps = 0;
    while (cur && cur !== document.body && steps < 16) {
      if (cur.getAttribute && cur.getAttribute("data-appable") === "non-editable") return true;
      cur = cur.parentElement;
      steps++;
    }
    return false;
  }

  /** Prefer the nearest specific testID, not a screen-level parent. */
  function findNearestTestId(el) {
    var cur = el;
    var broad = null;
    var steps = 0;
    while (cur && cur !== document.body && steps < 12) {
      var tid = testIdOn(cur);
      if (tid) {
        if (!isBroadTestId(tid)) return tid;
        if (!broad) broad = tid;
      }
      cur = cur.parentElement;
      steps++;
    }
    return broad;
  }

  /** A testID that looks like a leaf text node (e.g. `…-value`, `…-label`)
   *  is the wrong target for "change the background of this card". Walk up
   *  to the next non-broad testID that isn't a text-leaf suffix. */
  var TEXT_LEAF_SUFFIX_RE = /-(value|label|name|title|text|desc|message|header|icon|chevron|tagline|built|version|toggle|input|placeholder|empty|loading|error|content|subtitle|body|caption)$/;
  function findBoxTestId(el) {
    var nearest = findNearestTestId(el);
    if (!nearest) return null;
    if (!TEXT_LEAF_SUFFIX_RE.test(nearest)) return nearest;
    var cur = el && el.parentElement;
    var steps = 0;
    while (cur && cur !== document.body && steps < 12) {
      var tid = testIdOn(cur);
      if (tid && !isBroadTestId(tid) && !TEXT_LEAF_SUFFIX_RE.test(tid)) return tid;
      cur = cur.parentElement;
      steps++;
    }
    return nearest;
  }

  function textChildAtPoint(parent, x, y) {
    if (!parent || !parent.children) return null;
    for (var i = parent.children.length - 1; i >= 0; i--) {
      var c = parent.children[i];
      var r = c.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return c;
      }
    }
    return null;
  }

  var MAX_TEXT_LABEL = 64;

  function shortLabel(text) {
    if (!text) return "";
    var line = String(text).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    return line.length > MAX_TEXT_LABEL ? line.slice(0, MAX_TEXT_LABEL) : line;
  }

  function leafTextLabel(el) {
    if (!el) return "";
    var kids = [];
    for (var i = 0; i < el.children.length; i++) {
      if ((el.children[i].innerText || "").trim()) kids.push(el.children[i]);
    }
    if (kids.length > 1) return "";
    if (kids.length === 1) {
      var nested = leafTextLabel(kids[0]);
      return nested || shortLabel(kids[0].innerText || kids[0].textContent || "");
    }
    return shortLabel(el.innerText || el.textContent || "");
  }

  function firstLabelIn(el) {
    if (!el) return "";
    var lbl = leafTextLabel(el);
    if (lbl) return lbl;
    if (!el.children) return "";
    for (var i = 0; i < el.children.length; i++) {
      lbl = firstLabelIn(el.children[i]);
      if (lbl) return lbl;
    }
    return "";
  }

  function iconDisplayText(el) {
    var t = shortLabel(el.innerText || el.textContent || "");
    return t || "icon";
  }

  function isIconLike(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = (el.tagName || "").toLowerCase();
    if (tag === "svg" || (el.querySelector && el.querySelector("svg"))) return true;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    if (r.width > 80 || r.height > 80) return false;
    try {
      var ff = (window.getComputedStyle(el).fontFamily || "").toLowerCase();
      if (/ionicons|material icons|materialicons|fontawesome|anticon|feather|expo|glyph|icon/.test(ff)) {
        return true;
      }
    } catch (_e) {}
    var text = (el.innerText || el.textContent || "").trim();
    if (!text) return r.width < 64 && r.height < 64;
    if (text.length <= 2 && /[\p{Extended_Pictographic}\p{So}]/u.test(text)) return true;
    if (text.length === 1 && !/[a-zA-Z0-9]/.test(text)) return true;
    return false;
  }

  /** Sibling spans split for partial color (e.g. "Sp" + "aghetti") — edit as one label. */
  function childrenAreAllTextLeaves(el) {
    if (!el || !el.children || el.children.length < 2) return false;
    for (var i = 0; i < el.children.length; i++) {
      var ch = el.children[i];
      if (isIconLike(ch)) return false;
      if (ch.children && ch.children.length > 0) return false;
    }
    return Boolean(shortLabel(el.innerText || el.textContent || ""));
  }

  function partForElement(parts, el) {
    if (!el) return null;
    var best = null;
    var bestDepth = Infinity;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.el === el || (p.el.contains && p.el.contains(el))) {
        var depth = 0;
        var cur = el;
        while (cur && cur !== p.el) {
          depth++;
          cur = cur.parentElement;
        }
        if (depth < bestDepth) {
          best = p;
          bestDepth = depth;
        }
      }
    }
    return best;
  }

  function collectEditableParts(root) {
    var parts = [];
    var used = [];
    function add(el, text, isIcon) {
      if (!el || used.indexOf(el) >= 0) return;
      used.push(el);
      parts.push({ text: text, el: el, isIcon: isIcon });
    }
    function walk(el) {
      if (!el || !root.contains(el)) return;
      if (isIconLike(el)) {
        add(el, iconDisplayText(el), true);
        return;
      }
      if (childrenAreAllTextLeaves(el)) {
        add(el, shortLabel(el.innerText || el.textContent || ""), false);
        return;
      }
      var lbl = leafTextLabel(el);
      if (lbl) {
        var textKids = 0;
        for (var i = 0; i < el.children.length; i++) {
          if ((el.children[i].innerText || "").trim()) textKids++;
        }
        if (textKids === 0) {
          add(el, lbl, false);
          return;
        }
      }
      for (var j = 0; j < el.children.length; j++) walk(el.children[j]);
    }
    walk(root);
    return parts;
  }

  function resolveTextTarget(el, x, y) {
    if (!el || el === document.body || el === document.documentElement) return null;
    var child = textChildAtPoint(el, x, y);
    if (child && child !== el) {
      var deeper = resolveTextTarget(child, x, y);
      if (deeper) return deeper;
    }
    var label = leafTextLabel(el);
    if (!label || label.length > MAX_TEXT_LABEL) return null;
    return { el: el, text: label };
  }

  function boxLimits() {
    var vw = window.innerWidth || 400;
    var vh = window.innerHeight || 800;
    return {
      minW: 36,
      minH: 24,
      maxW: vw * 0.52,
      maxH: vh * 0.42,
    };
  }

  function qualifiesAsBox(el, x, y, lim) {
    if (!el || el === document.body || el === document.documentElement) return false;
    var r = el.getBoundingClientRect();
    if (r.width < lim.minW || r.height < lim.minH) return false;
    if (r.width > lim.maxW || r.height > lim.maxH) return false;
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false;
    return true;
  }

  /** Smallest card/box under the tap — uses the hit stack, not a huge parent. */
  function pickBoxAtPoint(stack, x, y) {
    var lim = boxLimits();
    var best = null;
    var bestArea = Infinity;
    for (var i = 0; i < stack.length; i++) {
      var el = stack[i];
      if (!qualifiesAsBox(el, x, y, lim)) continue;
      var r = el.getBoundingClientRect();
      var area = r.width * r.height;
      if (area < bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  }

  /** Walk down into children at the tap when the parent row is too wide. */
  function drillBoxAtPoint(el, x, y, lim) {
    if (!el) return null;
    var child = textChildAtPoint(el, x, y);
    if (child && child !== el) {
      var deeper = drillBoxAtPoint(child, x, y, lim);
      if (deeper) return deeper;
    }
    if (qualifiesAsBox(el, x, y, lim)) return el;
    return null;
  }

  function pickCardContainer(seedEl, x, y) {
    var lim = boxLimits();
    var cur = seedEl;
    var best = null;
    var bestArea = Infinity;
    while (cur && cur !== document.body) {
      if (qualifiesAsBox(cur, x, y, lim)) {
        var r = cur.getBoundingClientRect();
        var area = r.width * r.height;
        if (area < bestArea) {
          best = cur;
          bestArea = area;
        }
      }
      cur = cur.parentElement;
    }
    return best || seedEl;
  }

  function pickTarget(clickEl, x, y) {
    var stack =
      typeof document.elementsFromPoint === "function"
        ? document.elementsFromPoint(x, y)
        : [clickEl];
    if (clickEl && clickEl.nodeType === 3) clickEl = clickEl.parentElement;
    if (clickEl && stack.indexOf(clickEl) === -1) stack.unshift(clickEl);

    var lim = boxLimits();
    var bgEl = pickBoxAtPoint(stack, x, y);
    if (!bgEl && clickEl) bgEl = drillBoxAtPoint(clickEl, x, y, lim);
    if (!bgEl && clickEl) bgEl = pickCardContainer(clickEl, x, y);

    var bestResolved = null;
    var bestArea = Infinity;
    var searchRoots = bgEl ? [bgEl] : [];
    for (var s = 0; s < stack.length; s++) {
      if (searchRoots.indexOf(stack[s]) === -1) searchRoots.push(stack[s]);
    }
    for (var j = 0; j < searchRoots.length; j++) {
      var resolved = resolveTextTarget(searchRoots[j], x, y);
      if (!resolved) continue;
      if (bgEl && !bgEl.contains(resolved.el)) continue;
      var rr = resolved.el.getBoundingClientRect();
      var a = rr.width * rr.height;
      if (a < bestArea) {
        bestArea = a;
        bestResolved = resolved;
      }
    }
    if (!bgEl && bestResolved) bgEl = pickCardContainer(bestResolved.el, x, y);
    if (!bgEl && clickEl) bgEl = pickCardContainer(clickEl, x, y);
    if (!bgEl) return null;

    var hitIcon = null;
    for (var hi = 0; hi < stack.length; hi++) {
      if (bgEl.contains(stack[hi]) && isIconLike(stack[hi])) {
        hitIcon = stack[hi];
        break;
      }
    }

    var parts = [];
    var boxLabel = firstLabelIn(bgEl);
    var styleEl = bestResolved ? bestResolved.el : bgEl;

    if (hitIcon) {
      styleEl = hitIcon;
      bestResolved = { el: hitIcon, text: iconDisplayText(hitIcon) };
      parts = [{ text: iconDisplayText(hitIcon), el: hitIcon, isIcon: true }];
    } else if (bestResolved) {
      var allParts = collectEditableParts(bgEl);
      var hit = partForElement(allParts, bestResolved.el);
      if (hit) {
        parts = [hit];
        styleEl = hit.el;
        bestResolved = { el: hit.el, text: hit.text };
      } else {
        parts = [
          {
            text: bestResolved.text,
            el: bestResolved.el,
            isIcon: isIconLike(bestResolved.el),
          },
        ];
        styleEl = bestResolved.el;
      }
    } else {
      // Empty padding / screen background — color only, not every label inside.
      parts = [];
      styleEl = bgEl;
    }

    var textTestId = findNearestTestId(styleEl);
    var boxTestId = findBoxTestId(bgEl);
    if (boxTestId && isBroadTestId(boxTestId)) boxTestId = null;
    var anchor = bestResolved ? bestResolved.text : boxLabel;
    var backgroundOnly = parts.length === 0;
    var screenBackground =
      backgroundOnly && (!boxTestId || isBroadTestId(findNearestTestId(bgEl) || ""));
    return {
      root: styleEl,
      parts: parts,
      anchorLabel: shortLabel(hitIcon ? boxLabel || anchor : anchor || boxLabel),
      textTestId: textTestId,
      boxTestId: boxTestId,
      testId: boxTestId || textTestId,
      styleEl: styleEl,
      bgEl: bgEl,
      backgroundOnly: backgroundOnly,
      screenBackground: screenBackground,
    };
  }

  function describe(pick) {
    var styleEl = pick.styleEl || pick.root;
    var bgEl = pick.bgEl || styleEl;
    var cs = window.getComputedStyle(styleEl);
    var bgCs = window.getComputedStyle(bgEl);
    return {
      testId: pick.testId,
      textTestId: pick.textTestId,
      boxTestId: pick.boxTestId,
      anchorLabel: pick.anchorLabel || shortLabel(pick.parts[0] && pick.parts[0].text),
      backgroundOnly: Boolean(pick.backgroundOnly),
      screenBackground: Boolean(pick.screenBackground),
      text: pick.parts.length === 1 ? pick.parts[0].text : "",
      textParts: pick.parts.map(function (p) {
        return { text: p.text, isIcon: Boolean(p.isIcon) };
      }),
      tag: styleEl.tagName ? styleEl.tagName.toLowerCase() : "",
      color: cs.color,
      backgroundColor: bgCs.backgroundColor,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      fontFamily: cs.fontFamily,
    };
  }

  function clearOutlineOnly() {
    if (lastHighlight) {
      lastHighlight.style.outline = lastOutline;
      lastHighlight = null;
    }
  }

  function clearHighlight() {
    clearOutlineOnly();
    lastPartEls = [];
    lastPartIsIcon = [];
    lastStyleEl = null;
    lastBgEl = null;
  }

  window.addEventListener("message", function (e) {
    var msg = e.data || {};
    if (msg.type === "appable:sync-storage-field") {
      var storageKey = "appdata";
      try {
        var raw = localStorage.getItem(storageKey);
        if (!raw) return;
        var data = JSON.parse(raw);
        if (!data || !Array.isArray(data.habits) || !msg.recordId) return;
        var field = msg.field || "name";
        for (var hi = 0; hi < data.habits.length; hi++) {
          if (data.habits[hi].id === msg.recordId) {
            data.habits[hi][field] = msg.value;
            localStorage.setItem(storageKey, JSON.stringify(data));
            break;
          }
        }
      } catch (syncErr) {
        /* ignore */
      }
    } else if (msg.type === "appable:edit-mode") {
      editMode = Boolean(msg.on);
      if (!editMode) clearHighlight();
      document.body.style.cursor = editMode ? "crosshair" : "";
    } else if (msg.type === "appable:apply-parts") {
      var items = msg.parts || [];
      for (var i = 0; i < items.length; i++) {
        var idx = items[i].index;
        var val = items[i].value;
        var el = lastPartEls[idx];
        if (!el) continue;
        if (lastPartIsIcon[idx] && !String(val || "").trim()) {
          el.style.display = "none";
        } else {
          el.style.display = "";
          if (lastPartIsIcon[idx]) {
            if (val) el.innerText = val;
          } else {
            el.innerText = val;
          }
        }
      }
    } else if (msg.type === "appable:apply" && lastStyleEl) {
      if (msg.prop === "color") lastStyleEl.style.color = msg.value;
      else if (msg.prop === "background" && lastBgEl) lastBgEl.style.backgroundColor = msg.value;
      else if (msg.prop === "fontWeight") lastStyleEl.style.fontWeight = msg.value;
      else if (msg.prop === "fontFamily") {
        if (msg.value === "System" || !msg.value) lastStyleEl.style.removeProperty("font-family");
        else lastStyleEl.style.fontFamily = msg.value;
      }
    } else if (msg.type === "appable:clear-outline") {
      clearOutlineOnly();
    } else if (msg.type === "appable:clear") {
      clearHighlight();
    }
  });

  document.addEventListener(
    "click",
    function (e) {
      if (!editMode) return;
      e.preventDefault();
      e.stopPropagation();
      var clickEl = e.target;
      if (clickEl && clickEl.nodeType === 3) clickEl = clickEl.parentElement;
      if (isNonEditable(clickEl)) return;
      var pick = pickTarget(e.target, e.clientX, e.clientY);
      if (!pick || !pick.root) return;
      clearHighlight();
      lastHighlight = pick.bgEl || pick.root;
      lastPartEls = pick.parts.map(function (p) {
        return p.el;
      });
      lastPartIsIcon = pick.parts.map(function (p) {
        return Boolean(p.isIcon);
      });
      lastStyleEl = pick.styleEl;
      lastBgEl = pick.bgEl;
      lastOutline = lastHighlight.style.outline;
      lastHighlight.style.outline = "2px solid #c8431d";
      lastHighlight.style.outlineOffset = "1px";
      window.parent.postMessage({ type: "appable:tapped", el: describe(pick) }, "*");
    },
    true
  );
}
