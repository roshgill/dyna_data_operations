// Two scroll modes for the left Steps panel:
// 1) New blank (unannotated) Step placed on timeline → scroll list to next Step (maxDefined+1)
// 2) A Step is selected (Step Outcome open) → center that Step + Outcome block
(() => {
  const VERSION = "0.18.58-scroll";
  /** Don't scroll-to-next for Step 1 — only once next target is Step 2+. */
  const MIN_TARGET_STEP = 2;
  const CENTER_TOL_PX = 40;
  const DEBOUNCE_MS = 140;
  const RETRY_MS = 80;
  const RETRY_MAX = 22;
  const LOG = "[dyna-scroll]";

  function log(...args) {
    try {
      console.log(LOG, ...args);
    } catch {
      /* ignore */
    }
  }

  function warn(...args) {
    try {
      console.warn(LOG, ...args);
    } catch {
      /* ignore */
    }
  }

  if (window.__encordAutoScrollNextStep?.version === VERSION) {
    log("already loaded", VERSION);
    return;
  }
  log("booting", VERSION, "prev=", window.__encordAutoScrollNextStep?.version || null);

  let debounceTimer = null;
  let retryTimer = null;
  /** @type {string | null} last mode+target key we successfully scrolled */
  let lastScrollKey = null;
  let lastAppliedScrollTop = null;
  /** @type {number} */
  let lastBlankCount = -1;
  /** @type {number} */
  let lastRangeTotal = -1;
  /** @type {number} */
  let lastLabeledMax = -1;
  /** Set when a new timeline Step range is detected; consumed by next-list / panel-open. */
  let pendingAnnotationPlace = false;
  let panelObserver = null;
  let stepRowObserver = null;
  /** @type {string | null} pending mode from schedule */
  let pendingMode = null;

  function normalizeLabel(raw) {
    return String(raw || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseStepNumber(label) {
    const m = String(label || "").match(/^step\s*(\d+)\b/i);
    return m ? Number(m[1]) : null;
  }

  function isIncompleteLabel(raw) {
    return /^incomplete$/i.test(normalizeLabel(raw));
  }

  function findRowByTestId(rowTestId) {
    const exact = document.querySelector(`[data-testid="${rowTestId}"]`);
    if (exact) return exact;
    const want = String(rowTestId || "").toLowerCase();
    if (!want) return null;
    return (
      [...document.querySelectorAll("[data-testid]")].find(
        (el) => (el.getAttribute("data-testid") || "").toLowerCase() === want
      ) || null
    );
  }

  function rangeLabel(rangeEl) {
    if (!rangeEl) return "";
    const span = rangeEl.querySelector(":scope > span");
    return normalizeLabel(
      span?.textContent ||
        rangeEl.getAttribute("aria-label") ||
        rangeEl.getAttribute("title") ||
        rangeEl.textContent ||
        ""
    );
  }

  /**
   * Timeline Step ranges: labeled Step N vs blank (not yet annotated).
   * Blank = no Step N label (and not Incomplete) — new annotation waiting for identity.
   */
  function timelineStepStats() {
    const row = findRowByTestId("row-step");
    if (!row) {
      return { maxDefined: 0, blank: 0, total: 0, labels: [] };
    }
    let maxDefined = 0;
    let blank = 0;
    const labels = [];
    for (const el of row.querySelectorAll('[data-testid="range"]')) {
      const label = rangeLabel(el);
      const n = parseStepNumber(label);
      labels.push({ label: label.slice(0, 40), n });
      if (n != null) {
        if (n > maxDefined) maxDefined = n;
      } else if (isIncompleteLabel(label)) {
        /* Incomplete is annotated — not blank */
      } else {
        // Empty or non-Step text = not yet identity-annotated
        blank += 1;
      }
    }
    return { maxDefined, blank, total: labels.length, labels };
  }

  function leftPanelRoot() {
    return (
      document.querySelector('[data-testid="object-left-panel"]') ||
      document.querySelector('[data-testid="editor-sider-top-pane"]') ||
      document.querySelector('[data-testid="editor-sider"]')
    );
  }

  function instanceIsStep() {
    const name = normalizeLabel(
      document.querySelector('[data-testid="instance-name"]')?.textContent || ""
    ).toLowerCase();
    return name === "step";
  }

  function countStepTreeitems(root) {
    let n = 0;
    for (const item of root.querySelectorAll('[role="treeitem"]')) {
      const text = normalizeLabel(
        item.querySelector(".ant-tree-title")?.textContent || item.textContent || ""
      );
      if (/^step\s*\d+\b/i.test(text)) n += 1;
    }
    return n;
  }

  function stepsPanelOpen() {
    if (!instanceIsStep()) return false;
    const root = leftPanelRoot();
    if (!root) return false;
    return countStepTreeitems(root) >= 1;
  }

  function describePort(el) {
    if (!el) return null;
    const style = getComputedStyle(el);
    return {
      tag: el.tagName,
      className: String(el.className || "").slice(0, 80),
      overflowY: style.overflowY,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTop: el.scrollTop,
      canScroll: el.scrollHeight > el.clientHeight + 1,
    };
  }

  function listScrollableAncestors(item) {
    const root = leftPanelRoot();
    const out = [];
    let node = item?.parentElement || null;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = getComputedStyle(node);
      const oy = style.overflowY;
      const scrollableY =
        (oy === "auto" || oy === "scroll" || oy === "overlay") &&
        node.scrollHeight > node.clientHeight + 1;
      if (scrollableY) out.push(node);
      if (root && node === root) break;
      if (node.getAttribute?.("data-testid") === "editor-sider") break;
      node = node.parentElement;
    }
    return out;
  }

  function findStepTreeitem(stepNum) {
    const want = Number(stepNum);
    if (!Number.isFinite(want) || want < 1) return null;
    const root = leftPanelRoot();
    if (!root) return null;
    const re = new RegExp(`^step\\s*${want}\\b`, "i");

    for (const item of root.querySelectorAll('[role="treeitem"]')) {
      const title =
        item.querySelector(".ant-tree-title") ||
        item.querySelector("label") ||
        item;
      const text = normalizeLabel(title.textContent || "");
      if (re.test(text)) return item;
    }
    return null;
  }

  function stepHeaderEl(treeitem) {
    if (!treeitem) return null;
    return (
      treeitem.querySelector(":scope > .ant-tree-node-content-wrapper") ||
      treeitem.querySelector(":scope > span.ant-tree-node-content-wrapper") ||
      treeitem.querySelector(".ant-tree-title") ||
      treeitem.querySelector("label.ant-radio-wrapper") ||
      treeitem.querySelector("label") ||
      treeitem
    );
  }

  function treeitemHasOutcome(treeitem) {
    if (!treeitem) return false;
    const text = normalizeLabel(treeitem.textContent || "");
    if (!/step\s*outcome/i.test(text)) return false;
    // Outcome choices mounted
    return !! [...treeitem.querySelectorAll("label, [role='radio'], .ant-tree-title")].find(
      (el) => /^(pass|fail|incomplete)\b/i.test(normalizeLabel(el.textContent || ""))
    );
  }

  function isChecked(el) {
    if (!el) return false;
    if (el.matches?.(".ant-radio-wrapper-checked, .ant-radio-checked")) return true;
    if (el.getAttribute?.("aria-checked") === "true") return true;
    if (el.classList?.contains("ant-tree-treenode-selected")) return true;
    return !!el.querySelector?.(
      ".ant-radio-wrapper-checked, .ant-radio-checked, input[type='radio']:checked"
    );
  }

  /**
   * Currently selected Step in the left panel (identity chosen, ideally with Outcome open).
   * @returns {{ stepNum: number, treeitem: Element, block: Element } | null}
   */
  function findSelectedStepContext() {
    const root = leftPanelRoot();
    if (!root || !instanceIsStep()) return null;

    const candidates = [];
    for (const item of root.querySelectorAll('[role="treeitem"]')) {
      const title =
        item.querySelector(".ant-tree-title") ||
        item.querySelector("label") ||
        item;
      const text = normalizeLabel(title.textContent || "");
      const stepNum = parseStepNumber(text);
      if (stepNum == null) continue;

      const checked = isChecked(item) || isChecked(title);
      const outcome = treeitemHasOutcome(item);
      if (checked || outcome) {
        candidates.push({ stepNum, treeitem: item, checked, outcome });
      }
    }

    if (!candidates.length) return null;
    // Prefer outcome-open, then checked, then highest step num
    candidates.sort(
      (a, b) =>
        Number(b.outcome) - Number(a.outcome) ||
        Number(b.checked) - Number(a.checked) ||
        b.stepNum - a.stepNum
    );
    const best = candidates[0];
    return {
      stepNum: best.stepNum,
      treeitem: best.treeitem,
      block: best.treeitem, // expanded treeitem = Step header + Outcome children
    };
  }

  function isRectCentered(rect, scrollport) {
    if (!rect || !scrollport) return false;
    const sr = scrollport.getBoundingClientRect();
    if (sr.height < 8 || rect.height <= 0) return false;
    const itemMid = rect.top + rect.height / 2;
    const portMid = sr.top + sr.height / 2;
    return Math.abs(itemMid - portMid) <= CENTER_TOL_PX;
  }

  /**
   * Center `el`'s bounding box in the nearest real scrollport.
   * For mode selected: pass the whole Step treeitem (header + Outcome), optionally smooth.
   * For mode next-list: pass the Step header only (instant).
   * @param {Element} el
   * @param {string} label
   * @param {{ smooth?: boolean }} [opts]
   */
  function centerInScrollport(el, label, opts = {}) {
    const smooth = !!opts.smooth;
    const behavior = smooth ? "smooth" : "auto";

    if (!el) {
      warn("center: no element", label);
      return { ok: false, reason: "no-element" };
    }

    const ports = listScrollableAncestors(el);
    log("center: ports", label, { smooth }, ports.map(describePort));

    if (!ports.length) {
      try {
        el.scrollIntoView({ block: "center", inline: "nearest", behavior });
      } catch {
        try {
          el.scrollIntoView(true);
        } catch {
          /* ignore */
        }
      }
      return { ok: false, reason: "no-scrollable-ancestor" };
    }

    let moved = false;
    let primary = ports[0];

    for (const port of ports) {
      const er = el.getBoundingClientRect();
      const sr = port.getBoundingClientRect();
      if (sr.height < 8) continue;

      const itemMid = er.top + er.height / 2;
      const portMid = sr.top + sr.height / 2;
      const delta = itemMid - portMid;
      const prev = port.scrollTop;
      const next = Math.max(
        0,
        Math.min(prev + delta, port.scrollHeight - port.clientHeight)
      );

      log("center: try", label, {
        ...describePort(port),
        smooth,
        delta: Math.round(delta),
        elH: Math.round(er.height),
        prev,
        next: Math.round(next),
      });

      if (Math.abs(next - prev) >= 1) {
        const prevBehavior = port.style.scrollBehavior;
        if (smooth) port.style.scrollBehavior = "smooth";
        port.scrollTop = next;
        if (smooth) {
          // Restore after the smooth animation window so later instant scrolls stay snappy
          setTimeout(() => {
            port.style.scrollBehavior = prevBehavior;
          }, 400);
        }
        const after = port.scrollTop;
        log("center: applied", prev, "→", after);
        // Smooth scroll may report scrollTop unchanged until the animation runs
        if (smooth || Math.abs(after - prev) >= 1) {
          moved = true;
          primary = port;
        } else {
          warn("center: scrollTop refused");
        }
      } else if (isRectCentered(er, port)) {
        moved = true;
        primary = port;
      }
    }

    if (!moved) {
      try {
        el.scrollIntoView({ block: "center", inline: "nearest", behavior });
        log("center: scrollIntoView fallback", label, { smooth });
        moved = true;
      } catch {
        /* ignore */
      }
    }

    const rect = el.getBoundingClientRect();
    // During smooth scroll, mid-point may not match yet — treat moved as success
    const visible = smooth ? moved : ports.some((p) => isRectCentered(rect, p));
    return {
      ok: moved || visible,
      moved,
      visible,
      scrollTop: primary?.scrollTop ?? null,
      reason: moved || visible ? "ok" : "scroll-ignored",
    };
  }

  /**
   * @param {{ mode?: 'next-list'|'selected'|'auto', force?: boolean, attempt?: number }} [opts]
   */
  function runScroll(opts = {}) {
    const attempt = opts.attempt || 0;
    let mode = opts.mode || pendingMode || "auto";
    pendingMode = null;

    if (!location.pathname.includes("/label_editor/")) {
      return { ok: false, reason: "not-editor" };
    }
    if (!stepsPanelOpen()) {
      if (attempt < RETRY_MAX) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(
          () => runScroll({ ...opts, mode, attempt: attempt + 1 }),
          RETRY_MS
        );
        return { ok: false, reason: "panel-not-open", attempt };
      }
      return { ok: false, reason: "panel-not-open" };
    }

    const stats = timelineStepStats();
    const selected = findSelectedStepContext();
    log("runScroll: state", { mode, stats, selected: selected?.stepNum ?? null, attempt });

    // Auto: selected+outcome wins; else next-list if a new annotation was just placed / blank exists
    if (mode === "auto") {
      if (selected?.outcome && !pendingAnnotationPlace) mode = "selected";
      else if (pendingAnnotationPlace || stats.blank >= 1) mode = "next-list";
      else if (selected?.outcome) mode = "selected";
      else if (selected) mode = "selected";
      else {
        log("runScroll: nothing to do");
        return { ok: true, skipped: true, reason: "idle" };
      }
    }

    // Mode 1 — scroll list to next Step after a new timeline annotation is placed
    if (mode === "next-list") {
      const targetNum = stats.maxDefined + 1;
      if (targetNum < MIN_TARGET_STEP) {
        log("runScroll: next-list before Step 2", { targetNum, stats });
        pendingAnnotationPlace = false;
        return { ok: true, skipped: true, reason: "before-step-2", targetNum };
      }
      const item = findStepTreeitem(targetNum);
      if (!item) {
        if (attempt < RETRY_MAX) {
          clearTimeout(retryTimer);
          retryTimer = setTimeout(
            () => runScroll({ ...opts, mode: "next-list", force: true, attempt: attempt + 1 }),
            RETRY_MS
          );
          return { ok: false, reason: "treeitem-missing", targetNum, attempt };
        }
        warn("runScroll: next-list treeitem-missing FINAL", { targetNum, stats });
        return { ok: false, reason: "treeitem-missing", targetNum };
      }

      const key = `next:${targetNum}:t${stats.total}:b${stats.blank}`;
      const anchor = stepHeaderEl(item);
      if (!opts.force && lastScrollKey === key && lastAppliedScrollTop != null) {
        const ports = listScrollableAncestors(anchor || item);
        if (ports.some((p) => isRectCentered((anchor || item).getBoundingClientRect(), p))) {
          log("runScroll: next-list skip — already centered", key);
          pendingAnnotationPlace = false;
          return { ok: true, skipped: true, mode, targetNum };
        }
      }

      log("runScroll: next-list → Step", targetNum, {
        pendingAnnotationPlace,
        blank: stats.blank,
        total: stats.total,
        maxDefined: stats.maxDefined,
      });
      const result = centerInScrollport(anchor || item, `next-Step-${targetNum}`);
      if (!result.ok && attempt < RETRY_MAX) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(
          () => runScroll({ ...opts, mode: "next-list", force: true, attempt: attempt + 1 }),
          RETRY_MS
        );
        return { ok: false, reason: result.reason, targetNum, attempt };
      }
      if (result.ok) {
        lastScrollKey = key;
        lastAppliedScrollTop = result.scrollTop;
        lastBlankCount = stats.blank;
        lastRangeTotal = stats.total;
        lastLabeledMax = stats.maxDefined;
        pendingAnnotationPlace = false;
      }
      log("runScroll: next-list done", result);
      return { ok: result.ok, mode, targetNum, ...result };
    }

    // Mode 2 — center selected Step + Outcome block
    if (mode === "selected") {
      const ctx = selected || findSelectedStepContext();
      if (!ctx) {
        if (attempt < RETRY_MAX) {
          clearTimeout(retryTimer);
          retryTimer = setTimeout(
            () => runScroll({ ...opts, mode: "selected", attempt: attempt + 1 }),
            RETRY_MS
          );
          return { ok: false, reason: "no-selection" };
        }
        return { ok: false, reason: "no-selection" };
      }

      const key = `sel:${ctx.stepNum}:out${ctx.treeitem && treeitemHasOutcome(ctx.treeitem) ? 1 : 0}`;
      if (!opts.force && lastScrollKey === key && lastAppliedScrollTop != null) {
        const ports = listScrollableAncestors(ctx.block);
        if (ports.some((p) => isRectCentered(ctx.block.getBoundingClientRect(), p))) {
          log("runScroll: selected skip — already centered", key);
          return { ok: true, skipped: true, mode, stepNum: ctx.stepNum };
        }
      }

      log("runScroll: selected → center Step", ctx.stepNum, "+ outcome block (smooth)");
      const result = centerInScrollport(ctx.block, `selected-Step-${ctx.stepNum}`, {
        smooth: true,
      });
      if (!result.ok && attempt < RETRY_MAX) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(
          () => runScroll({ ...opts, mode: "selected", force: true, attempt: attempt + 1 }),
          RETRY_MS
        );
        return { ok: false, reason: result.reason, stepNum: ctx.stepNum };
      }
      if (result.ok) {
        lastScrollKey = key;
        lastAppliedScrollTop = result.scrollTop;
        lastBlankCount = stats.blank;
        lastRangeTotal = stats.total;
        lastLabeledMax = stats.maxDefined;
      }
      log("runScroll: selected done", result);
      return { ok: result.ok, mode, stepNum: ctx.stepNum, ...result };
    }

    return { ok: false, reason: "unknown-mode", mode };
  }

  function scheduleScroll(reason, mode = "auto") {
    log("scheduleScroll:", reason, mode, {
      pendingAnnotationPlace,
      lastRangeTotal,
      lastBlankCount,
    });
    pendingMode = mode;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        if (
          reason === "range-added" ||
          reason === "blank-placed" ||
          reason === "panel-open-after-place" ||
          reason === "force"
        ) {
          lastScrollKey = null;
          lastAppliedScrollTop = null;
        }
        runScroll({
          mode,
          force:
            reason === "force" ||
            reason === "range-added" ||
            reason === "blank-placed" ||
            reason === "panel-open-after-place" ||
            reason === "step-selected",
        });
      } catch (err) {
        warn("scheduleScroll error", err);
      }
    }, DEBOUNCE_MS);
  }

  function noteAnnotationPlaced(via, stats) {
    pendingAnnotationPlace = true;
    lastBlankCount = stats.blank;
    lastRangeTotal = stats.total;
    lastLabeledMax = stats.maxDefined;
    log("annotation placed:", via, stats);
    scheduleScroll(via, "next-list");
  }

  function ensureStepRowObserver() {
    if (stepRowObserver) return;
    const attach = () => {
      const row = findRowByTestId("row-step");
      if (!row) return false;
      if (row.dataset.encordAutoScrollWatch === "1") return true;
      row.dataset.encordAutoScrollWatch = "1";
      const initial = timelineStepStats();
      lastBlankCount = initial.blank;
      lastRangeTotal = initial.total;
      lastLabeledMax = initial.maxDefined;
      log("stepRowObserver: attached", {
        testId: row.getAttribute("data-testid"),
        ...initial,
      });

      stepRowObserver = new MutationObserver(() => {
        const stats = timelineStepStats();
        const totalUp = stats.total > lastRangeTotal;
        const blankUp = stats.blank > lastBlankCount;
        if (totalUp || blankUp) {
          log("stepRowObserver: new step annotation", {
            total: `${lastRangeTotal}→${stats.total}`,
            blank: `${lastBlankCount}→${stats.blank}`,
            maxDefined: stats.maxDefined,
          });
          noteAnnotationPlaced(totalUp ? "range-added" : "blank-placed", stats);
          return;
        }
        lastBlankCount = stats.blank;
        lastRangeTotal = stats.total;
        lastLabeledMax = stats.maxDefined;
      });
      stepRowObserver.observe(row, {
        attributes: true,
        subtree: true,
        attributeFilter: ["style", "class"],
        childList: true,
        characterData: true,
      });
      return true;
    };
    if (attach()) return;
    const boot = new MutationObserver(() => {
      if (attach()) boot.disconnect();
    });
    boot.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => boot.disconnect(), 60000);
  }

  function ensurePanelObserver() {
    if (panelObserver) return;
    let wasOpen = false;
    let wasOutcome = false;
    let wasSelectedNum = null;

    panelObserver = new MutationObserver(() => {
      const open = stepsPanelOpen();

      // Mode 1: panel just opened after a new annotation place
      if (open && !wasOpen && pendingAnnotationPlace) {
        log("panelObserver: OPEN after annotation place → next-list");
        scheduleScroll("panel-open-after-place", "next-list");
      }

      if (!open) {
        wasOpen = false;
        wasOutcome = false;
        wasSelectedNum = null;
        return;
      }
      wasOpen = true;

      const selected = findSelectedStepContext();
      const hasOutcome = !!(selected && treeitemHasOutcome(selected.treeitem));

      // Mode 2: Step just selected / Outcome just opened (unchanged)
      if (selected && (hasOutcome || selected.stepNum !== wasSelectedNum)) {
        if (hasOutcome && !wasOutcome) {
          log("panelObserver: Outcome opened for Step", selected.stepNum);
          pendingAnnotationPlace = false;
          scheduleScroll("step-selected", "selected");
        } else if (
          selected.stepNum !== wasSelectedNum &&
          selected.stepNum != null
        ) {
          log("panelObserver: Step selected", selected.stepNum);
          pendingAnnotationPlace = false;
          scheduleScroll("step-selected", "selected");
        }
      }

      wasOutcome = hasOutcome;
      wasSelectedNum = selected?.stepNum ?? null;
    });
    panelObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "aria-checked", "aria-expanded"],
    });
    log("panelObserver: start");
  }

  function startWatch() {
    log("startWatch");
    setTimeout(() => {
      if (!location.pathname.includes("/label_editor/")) return;
      ensureStepRowObserver();
      ensurePanelObserver();
      const stats = timelineStepStats();
      if (stats.blank >= 1 && stepsPanelOpen()) {
        pendingAnnotationPlace = true;
        scheduleScroll("boot-blank", "next-list");
      } else if (findSelectedStepContext()) {
        scheduleScroll("boot-selected", "selected");
      }
    }, 600);

    // Placing a Step often ends with pointerup on the classification timeline
    document.addEventListener(
      "pointerup",
      (event) => {
        if (!event.isTrusted) return;
        if (!location.pathname.includes("/label_editor/")) return;
        const inTimeline = !!event.target?.closest?.(
          '[data-testid="classification-timeline"], [data-testid="range"]'
        );
        const row = findRowByTestId("row-step");
        if (!inTimeline && !(row && row.contains(event.target))) return;

        // After place, DOM updates a tick later — re-check totals
        setTimeout(() => {
          const stats = timelineStepStats();
          if (stats.total > lastRangeTotal || stats.blank > lastBlankCount) {
            noteAnnotationPlaced("timeline-pointer-range", stats);
          } else if (instanceIsStep() && stepsPanelOpen() && pendingAnnotationPlace) {
            scheduleScroll("timeline-pointer-pending", "next-list");
          }
        }, 200);
      },
      true
    );

    // Clicking a Step option in the left panel → mode selected
    document.addEventListener(
      "click",
      (event) => {
        if (!event.isTrusted) return;
        if (!location.pathname.includes("/label_editor/")) return;
        const panel = leftPanelRoot();
        if (!panel || !panel.contains(event.target)) return;
        const treeitem = event.target?.closest?.('[role="treeitem"]');
        if (!treeitem) return;
        const title =
          treeitem.querySelector(".ant-tree-title") ||
          treeitem.querySelector("label") ||
          treeitem;
        const stepNum = parseStepNumber(title.textContent || "");
        if (stepNum == null) return;
        log("trigger: panel step click", stepNum);
        pendingAnnotationPlace = false;
        scheduleScroll("panel-step-click", "selected");
      },
      true
    );

    // Hotkey selection (Q–T etc.) — Outcome may mount after; don't steal mode 1
    document.addEventListener(
      "keyup",
      (event) => {
        if (!event.isTrusted) return;
        if (!location.pathname.includes("/label_editor/")) return;
        if (!stepsPanelOpen()) return;
        if (pendingAnnotationPlace) {
          scheduleScroll("panel-key-pending-place", "next-list");
          return;
        }
        scheduleScroll("panel-key", "auto");
      },
      true
    );
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "AUTO_SCROLL_NEXT_STEP") {
      lastScrollKey = null;
      lastAppliedScrollTop = null;
      sendResponse(runScroll({ mode: "next-list", force: true }));
      return false;
    }
    if (message?.type === "AUTO_SCROLL_STATUS") {
      const stats = timelineStepStats();
      const selected = findSelectedStepContext();
      sendResponse({
        ok: true,
        version: VERSION,
        stats,
        selected: selected?.stepNum ?? null,
        lastScrollKey,
        lastAppliedScrollTop,
        panelOpen: stepsPanelOpen(),
      });
      return false;
    }
    return false;
  });

  window.__encordAutoScrollNextStep = {
    version: VERSION,
    runScroll,
    timelineStepStats,
    findSelectedStepContext,
    findStepTreeitem,
    stepsPanelOpen,
  };

  startWatch();
  log("ready", VERSION);
})();
