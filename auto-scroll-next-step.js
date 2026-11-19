// Two scroll modes for the left Steps panel:
// 1) New blank (unannotated) Step placed on timeline → scroll list to next Step (maxDefined+1)
// 2) A Step is selected (Step Outcome open) → center that Step + Outcome block
(() => {
  const VERSION = "0.18.86-scroll";
  const STORAGE_NEXT = "autoScrollNextStepEnabled";
  const STORAGE_CENTER = "autoScrollCenterStepEnabled";
  const STORAGE_LEGACY = "autoScrollEnabled";
  /** Don't scroll-to-next for Step 1 on the first cycle — only once a Step is already labeled. */
  const MIN_TARGET_STEP = 2;
  const CENTER_TOL_PX = 40;
  const DEBOUNCE_MS = 140;
  const RETRY_MS = 80;
  const RETRY_MAX = 22;
  /** Ignore scroll events from our own scrollTop writes. */
  const PROGRAMMATIC_SCROLL_GRACE_MS = 600;
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

  /** Suggest next Step to label — opt in (off by default). */
  let nextStepEnabled = false;
  /** Center selected Step + Outcome — on by default. */
  let centerStepEnabled = true;
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
  /**
   * When true, auto-scroll will not move the panel. Armed after any successful
   * auto-scroll or trusted user wheel/scroll in the Steps list. Cleared only on
   * a new blank range place or an explicit Step change (click / hotkey).
   */
  let scrollLock = false;
  /** @type {number | null} Step that was centered when lock armed (for change detection). */
  let lockedStepNum = null;
  /** @type {'next-list'|'selected'|'user'|null} */
  let lockSource = null;
  let ignoreScrollUntil = 0;

  function anyScrollEnabled() {
    return nextStepEnabled || centerStepEnabled;
  }

  async function loadEnabled() {
    try {
      const stored = await chrome.storage.local.get([
        STORAGE_NEXT,
        STORAGE_CENTER,
        STORAGE_LEGACY,
      ]);
      if (typeof stored[STORAGE_NEXT] === "boolean") {
        nextStepEnabled = stored[STORAGE_NEXT] === true;
      } else {
        // Legacy single toggle mapped to next-step suggest
        nextStepEnabled = stored[STORAGE_LEGACY] === true;
      }
      centerStepEnabled = stored[STORAGE_CENTER] !== false;
    } catch {
      nextStepEnabled = false;
      centerStepEnabled = true;
    }
    log("enabled next=", nextStepEnabled, "center=", centerStepEnabled);
  }

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

  /** Lowest numbered Step treeitem in the ontology list (usually Step 1). */
  function findFirstStepTreeitem() {
    const root = leftPanelRoot();
    if (!root) return null;
    let best = null;
    let bestNum = Infinity;
    for (const item of root.querySelectorAll('[role="treeitem"]')) {
      const title =
        item.querySelector(".ant-tree-title") ||
        item.querySelector("label") ||
        item;
      const n = parseStepNumber(title.textContent || "");
      if (n != null && n < bestNum) {
        bestNum = n;
        best = item;
      }
    }
    return best ? { stepNum: bestNum, treeitem: best } : null;
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

  function armScrollLock(stepNum, why) {
    scrollLock = true;
    lockedStepNum = stepNum != null && Number.isFinite(Number(stepNum)) ? Number(stepNum) : lockedStepNum;
    if (String(why).startsWith("next-list")) lockSource = "next-list";
    else if (String(why).startsWith("user")) lockSource = "user";
    else lockSource = "selected";
    clearTimeout(retryTimer);
    retryTimer = null;
    clearTimeout(debounceTimer);
    debounceTimer = null;
    log("scrollLock ON", why, "step", lockedStepNum, "source", lockSource);
  }

  function clearScrollLock(why) {
    if (!scrollLock && lockedStepNum == null) return;
    log("scrollLock OFF", why, "was", lockedStepNum, lockSource);
    scrollLock = false;
    lockedStepNum = null;
    lockSource = null;
  }

  function eventInStepsPanel(target) {
    const panel = leftPanelRoot();
    return !!(panel && target && panel.contains(target));
  }

  /**
   * @param {{ mode?: 'next-list'|'selected'|'auto', force?: boolean, attempt?: number }} [opts]
   */
  function runScroll(opts = {}) {
    const attempt = opts.attempt || 0;
    let mode = opts.mode || pendingMode || "auto";
    pendingMode = null;

    if (!anyScrollEnabled() && !opts.force) {
      return { ok: true, skipped: true, reason: "disabled" };
    }
    if (scrollLock) {
      log("runScroll: locked — skip", mode);
      return { ok: true, skipped: true, reason: "scroll-lock", mode };
    }
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
    log("runScroll: state", {
      mode,
      stats,
      selected: selected?.stepNum ?? null,
      attempt,
      scrollLock,
      lockedStepNum,
      nextStepEnabled,
      centerStepEnabled,
    });

    // Auto: pick an enabled mode only
    if (mode === "auto") {
      if (centerStepEnabled && selected?.outcome && !pendingAnnotationPlace) mode = "selected";
      else if (nextStepEnabled && (pendingAnnotationPlace || stats.blank >= 1)) mode = "next-list";
      else if (centerStepEnabled && selected?.outcome) mode = "selected";
      else if (centerStepEnabled && selected) mode = "selected";
      else if (nextStepEnabled && (pendingAnnotationPlace || stats.blank >= 1)) mode = "next-list";
      else {
        log("runScroll: nothing to do");
        return { ok: true, skipped: true, reason: "idle" };
      }
    }

    // Mode 1 — scroll list to next Step after a new timeline annotation is placed
    if (mode === "next-list") {
      if (!nextStepEnabled && !opts.force) {
        return { ok: true, skipped: true, reason: "next-step-disabled" };
      }
      let targetNum = stats.maxDefined + 1;
      let wrapped = false;
      // First cycle only: don't auto-scroll to Step 1 before any Step is labeled
      if (stats.maxDefined < 1 && targetNum < MIN_TARGET_STEP) {
        log("runScroll: next-list before Step 2", { targetNum, stats });
        pendingAnnotationPlace = false;
        return { ok: true, skipped: true, reason: "before-step-2", targetNum };
      }

      let item = findStepTreeitem(targetNum);
      // Cycle wrap: after last ontology Step (e.g. 5), show Step 1 again
      if (!item && stats.maxDefined >= 1) {
        const first = findFirstStepTreeitem();
        if (first) {
          item = first.treeitem;
          targetNum = first.stepNum;
          wrapped = true;
          log("runScroll: next-list wrap → Step", targetNum, {
            maxDefined: stats.maxDefined,
          });
        }
      }
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

      const key = `next:${targetNum}:t${stats.total}:b${stats.blank}:w${wrapped ? 1 : 0}`;
      const anchor = stepHeaderEl(item);
      if (!opts.force && lastScrollKey === key && lastAppliedScrollTop != null) {
        const ports = listScrollableAncestors(anchor || item);
        if (ports.some((p) => isRectCentered((anchor || item).getBoundingClientRect(), p))) {
          log("runScroll: next-list skip — already centered", key);
          pendingAnnotationPlace = false;
          armScrollLock(targetNum, "next-list-already-centered");
          return { ok: true, skipped: true, mode, targetNum, wrapped };
        }
      }

      log("runScroll: next-list → Step", targetNum, {
        pendingAnnotationPlace,
        blank: stats.blank,
        total: stats.total,
        maxDefined: stats.maxDefined,
        wrapped,
      });
      ignoreScrollUntil = Date.now() + PROGRAMMATIC_SCROLL_GRACE_MS;
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
        armScrollLock(targetNum, "next-list");
      }
      log("runScroll: next-list done", result);
      return { ok: result.ok, mode, targetNum, wrapped, ...result };
    }

    // Mode 2 — center selected Step + Outcome block
    if (mode === "selected") {
      if (!centerStepEnabled && !opts.force) {
        return { ok: true, skipped: true, reason: "center-step-disabled" };
      }
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
          armScrollLock(ctx.stepNum, "selected-already-centered");
          return { ok: true, skipped: true, mode, stepNum: ctx.stepNum };
        }
      }

      log("runScroll: selected → center Step", ctx.stepNum, "+ outcome block (smooth)");
      ignoreScrollUntil = Date.now() + PROGRAMMATIC_SCROLL_GRACE_MS;
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
        armScrollLock(ctx.stepNum, "selected");
      }
      log("runScroll: selected done", result);
      return { ok: result.ok, mode, stepNum: ctx.stepNum, ...result };
    }

    return { ok: false, reason: "unknown-mode", mode };
  }

  function scheduleScroll(reason, mode = "auto") {
    if (!anyScrollEnabled()) {
      log("scheduleScroll: skipped (disabled)", reason);
      return;
    }
    if (mode === "next-list" && !nextStepEnabled) {
      log("scheduleScroll: next-step off", reason);
      return;
    }
    if (mode === "selected" && !centerStepEnabled) {
      log("scheduleScroll: center-step off", reason);
      return;
    }
    if (scrollLock) {
      log("scheduleScroll: locked — skip", reason, mode);
      return;
    }
    log("scheduleScroll:", reason, mode, {
      pendingAnnotationPlace,
      lastRangeTotal,
      lastBlankCount,
      scrollLock,
      nextStepEnabled,
      centerStepEnabled,
    });
    pendingMode = mode;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        if (!anyScrollEnabled() || scrollLock) return;
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
    if (!nextStepEnabled) return;
    clearScrollLock("annotation-placed");
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
          // After next-list, allow one Outcome center for that Step; otherwise stay locked.
          if (
            scrollLock &&
            lockSource === "next-list" &&
            lockedStepNum === selected.stepNum
          ) {
            clearScrollLock("outcome-after-next-list");
          }
          scheduleScroll("step-selected", "selected");
        } else if (
          selected.stepNum !== wasSelectedNum &&
          selected.stepNum != null
        ) {
          log("panelObserver: Step selected", selected.stepNum);
          pendingAnnotationPlace = false;
          if (scrollLock && lockedStepNum !== selected.stepNum) {
            clearScrollLock("panel-step-changed");
          }
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
    log("startWatch", { nextStepEnabled, centerStepEnabled });
    setTimeout(() => {
      if (!location.pathname.includes("/label_editor/")) return;
      ensureStepRowObserver();
      ensurePanelObserver();
      if (!anyScrollEnabled()) return;
      const stats = timelineStepStats();
      if (nextStepEnabled && stats.blank >= 1 && stepsPanelOpen()) {
        pendingAnnotationPlace = true;
        scheduleScroll("boot-blank", "next-list");
      } else if (centerStepEnabled && findSelectedStepContext()) {
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

    // User took over the Steps list — stop auto-centering immediately.
    document.addEventListener(
      "wheel",
      (event) => {
        if (!event.isTrusted) return;
        if (!eventInStepsPanel(event.target)) return;
        armScrollLock(lockedStepNum, "user-wheel");
      },
      { capture: true, passive: true }
    );
    document.addEventListener(
      "scroll",
      (event) => {
        if (!event.isTrusted) return;
        if (Date.now() < ignoreScrollUntil) return;
        if (!eventInStepsPanel(event.target)) return;
        armScrollLock(lockedStepNum, "user-scroll");
      },
      { capture: true, passive: true }
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
        // Same Step while locked: only unlock if Outcome isn't open yet (one center).
        if (scrollLock && lockedStepNum === stepNum) {
          if (treeitemHasOutcome(treeitem)) {
            log("trigger: same Step + Outcome while locked — leave scroll alone");
            return;
          }
          clearScrollLock("step-click-await-outcome");
        } else {
          clearScrollLock("step-click");
        }
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
          clearScrollLock("key-pending-place");
          scheduleScroll("panel-key-pending-place", "next-list");
          return;
        }
        const selected = findSelectedStepContext();
        if (scrollLock) {
          // Only unlock when hotkey moved to a different Step.
          if (!selected || selected.stepNum === lockedStepNum) {
            log("trigger: key while locked — skip", lockedStepNum);
            return;
          }
          clearScrollLock("step-key-changed");
        }
        scheduleScroll("panel-key", "auto");
      },
      true
    );
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "AUTO_SCROLL_NEXT_STEP") {
      if (!nextStepEnabled) {
        sendResponse({ ok: true, skipped: true, reason: "next-step-disabled" });
        return false;
      }
      lastScrollKey = null;
      lastAppliedScrollTop = null;
      clearScrollLock("message-next-step");
      sendResponse(runScroll({ mode: "next-list", force: true }));
      return false;
    }
    if (message?.type === "AUTO_SCROLL_STATUS") {
      const stats = timelineStepStats();
      const selected = findSelectedStepContext();
      sendResponse({
        ok: true,
        version: VERSION,
        nextStepEnabled,
        centerStepEnabled,
        enabled: anyScrollEnabled(),
        stats,
        selected: selected?.stepNum ?? null,
        lastScrollKey,
        lastAppliedScrollTop,
        panelOpen: stepsPanelOpen(),
        scrollLock,
        lockedStepNum,
      });
      return false;
    }
    if (message?.type === "AUTO_SCROLL_SET_ENABLED") {
      if (typeof message.nextStepEnabled === "boolean") {
        nextStepEnabled = message.nextStepEnabled === true;
      }
      if (typeof message.centerStepEnabled === "boolean") {
        centerStepEnabled = message.centerStepEnabled === true;
      }
      // Legacy payload
      if (
        typeof message.enabled === "boolean" &&
        typeof message.nextStepEnabled !== "boolean" &&
        typeof message.centerStepEnabled !== "boolean"
      ) {
        nextStepEnabled = message.enabled === true;
      }
      log("AUTO_SCROLL_SET_ENABLED", { nextStepEnabled, centerStepEnabled });
      sendResponse({ ok: true, nextStepEnabled, centerStepEnabled });
      return false;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE_NEXT]) {
      nextStepEnabled = changes[STORAGE_NEXT].newValue === true;
      log("storage next →", nextStepEnabled);
    }
    if (changes[STORAGE_CENTER]) {
      centerStepEnabled = changes[STORAGE_CENTER].newValue !== false;
      log("storage center →", centerStepEnabled);
    }
    if (changes[STORAGE_LEGACY] && typeof changes[STORAGE_NEXT] === "undefined") {
      nextStepEnabled = changes[STORAGE_LEGACY].newValue === true;
      log("storage legacy → next", nextStepEnabled);
    }
  });

  window.__encordAutoScrollNextStep = {
    version: VERSION,
    runScroll,
    timelineStepStats,
    findSelectedStepContext,
    findStepTreeitem,
    findFirstStepTreeitem,
    stepsPanelOpen,
    get enabled() {
      return anyScrollEnabled();
    },
    get nextStepEnabled() {
      return nextStepEnabled;
    },
    get centerStepEnabled() {
      return centerStepEnabled;
    },
    get scrollLock() {
      return scrollLock;
    },
  };

  loadEnabled().then(startWatch);
  log("ready", VERSION);
})();
