// Auto-sync Trajectory → Grade to 0 → end of last Step.
// Write path: Encord classification UI (frame jump + C/V/M or Range start/end inputs).
// No timeline draw-drag / alt-click / shift-click (those create single-frame pins).
(() => {
  const VERSION = "0.18.11-grade";
  const STORAGE_ENABLED = "autoGradeEnabled";
  // v2 key — invalidates bad caches that stored lastStepNum=2 from truncated scrapes
  const STORAGE_DEFINED_STEPS = "gradeSyncDefinedStepsV2";
  /** Grade must land on this camera when present (same as layout restore). */
  const PREFERRED_GRADE_TILE = "cam_high";
  const PCT_EPS = 0.4;
  const FRAME_EPS = 1; // playhead / goto verification only
  const BOUND_EPS = 0; // Grade vs Step end — 1 frame is a real change, not noise
  const WORKFLOW_DEBOUNCE_MS = 550;
  const LAST_STEP_RESIZE_DEBOUNCE_MS = 450;

  if (window.__encordGradeSync?.version === VERSION) return;

  let enabled = true;
  let syncing = false;
  let debounceTimer = null;
  let lastStepResizeTimer = null;
  let lastToastKey = "";
  let lastAppliedKey = "";
  let lastObservedStepEndKey = "";
  let stepRowObserver = null;
  /** @type {{ projectKey: string, lastStepNum: number, steps: { stepNum: number, label: string }[], via: string } | null} */
  let definedStepsCache = null;
  let discoveringSteps = false;

  function normalizeLabel(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function showToast(message, kind = "info") {
    const existing = document.getElementById("encord-camera-layout-toast");
    if (existing) existing.remove();

    const el = document.createElement("div");
    el.id = "encord-camera-layout-toast";
    el.textContent = message;
    const palette =
      kind === "error" || kind === "warn"
        ? {
            background: "#c62828",
            color: "#ffffff",
            border: "1px solid rgba(0, 0, 0, 0.12)",
          }
        : {
            background: "#f2f0e9",
            color: "#1a1a1a",
            border: "1px solid rgba(26, 26, 26, 0.12)",
          };

    Object.assign(el.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: "2147483647",
      maxWidth: "420px",
      padding: "10px 14px",
      borderRadius: "10px",
      background: palette.background,
      color: palette.color,
      border: palette.border,
      font: '13px/1.35 "Avenir Next", "Segoe UI", "Helvetica Neue", Helvetica, sans-serif',
      boxShadow: "0 4px 16px rgba(26, 26, 26, 0.08)",
      opacity: "0",
      transition: "opacity .15s ease",
      pointerEvents: "none",
    });
    document.documentElement.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = "1";
    });
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 200);
    }, 3200);
  }

  function parsePct(style, key) {
    const m = String(style || "").match(new RegExp(`${key}\\s*:\\s*([\\d.]+)%`, "i"));
    return m ? Number(m[1]) : null;
  }

  function getTotalFrames() {
    const el = document.querySelector('[data-testid="totalFrames"]');
    const n = Number(normalizeLabel(el?.textContent || "").replace(/[^\d]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function getCurrentFrame() {
    const el = document.querySelector('[data-testid="currentFrame"]');
    const n = Number(normalizeLabel(el?.textContent || "").replace(/[^\d]/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  function rangeLabel(rangeEl) {
    const span = rangeEl.querySelector(":scope > span");
    return normalizeLabel(span?.textContent || "");
  }

  function describeRange(rangeEl, { includePins = true } = {}) {
    const style = rangeEl.getAttribute("style") || "";
    const left = parsePct(style, "left");
    const width = parsePct(style, "width");
    if (left == null || width == null) return null;
    const isPin = width < 0.35 || /translateX\(-50%\)/i.test(style);
    if (!includePins && isPin && width < 0.05) return null;
    return {
      el: rangeEl,
      label: rangeLabel(rangeEl),
      left,
      width: Math.max(width, isPin ? 0.01 : width),
      end: left + Math.max(width, isPin ? 0.01 : width),
      pin: isPin,
    };
  }

  function findRowByTestId(rowTestId) {
    const exact = document.querySelector(`[data-testid="${rowTestId}"]`);
    if (exact) return exact;
    const want = String(rowTestId || "").toLowerCase();
    if (!want) return null;
    // Encord uses row-Step / row-Trajectory (class casing) on some projects.
    return (
      [...document.querySelectorAll("[data-testid]")].find(
        (el) => (el.getAttribute("data-testid") || "").toLowerCase() === want
      ) || null
    );
  }

  function listRanges(rowTestId, opts) {
    const row = findRowByTestId(rowTestId);
    if (!row) return [];
    return [...row.querySelectorAll('[data-testid="range"]')]
      .map((el) => describeRange(el, opts))
      .filter(Boolean);
  }

  function parseStepNumber(label) {
    const m = String(label || "").match(/^step\s*(\d+)\b/i);
    return m ? Number(m[1]) : null;
  }

  function getProjectKey() {
    const m = location.pathname.match(/\/label_editor\/([^/]+)/);
    return m ? m[1] : location.pathname;
  }

  function isInTimelineChrome(el) {
    if (!el?.closest) return false;
    if (
      el.closest(
        '[data-testid="classification-timeline"], [data-testid="scrollable-timeline-id"], [data-testid="timeline-left-rows-id"], [data-testid="range"]'
      )
    ) {
      return true;
    }
    let node = el;
    while (node && node !== document.documentElement) {
      const id = (node.getAttribute?.("data-testid") || "").toLowerCase();
      if (id === "row-step" || id === "row-trajectory" || /^row-/.test(id)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function isInLabelsPane(el) {
    return !!(
      el?.closest?.(
        '[data-testid="editor-sider-bottom-pane"], [data-testid="sider-labels-toggle"], [data-testid="data-group-labels-by-tile"]'
      )
    );
  }

  function listTimelineSteps() {
    return listRanges("row-step", { includePins: true })
      .map((r) => {
        const stepNum = parseStepNumber(r.label);
        const incomplete = isIncompleteStepLabel(r.label);
        return { ...r, stepNum, incomplete };
      })
      .filter((r) => (r.stepNum != null || r.incomplete) && (r.width >= 0.05 || r.pin));
  }

  /** Every Step timeline range including unlabeled pins (S2 create leaves empty labels). */
  function listAllStepRanges(totalFrames = getTotalFrames()) {
    return listRanges("row-step", { includePins: true })
      .map((r) => {
        const framed = withGradeFrames(r, totalFrames);
        if (!framed) return null;
        return {
          ...framed,
          stepNum: parseStepNumber(r.label),
          incomplete: isIncompleteStepLabel(r.label),
        };
      })
      .filter(Boolean);
  }

  /**
   * S2 finder: geometry first (empty-label pins are invisible to label filters).
   * Prefer pin / tiny range whose start is nearest to wantStart.
   */
  function findStepTailByGeometry(wantStart, totalFrames = getTotalFrames()) {
    if (wantStart == null || !totalFrames) return null;
    const all = listAllStepRanges(totalFrames);
    if (!all.length) return null;
    const tol = Math.max(BOUND_EPS, 3);
    const near = all.filter((r) => Math.abs(r.startFrame - wantStart) <= tol);
    const pool = near.length ? near : all.filter((r) => r.startFrame >= wantStart - tol);
    if (!pool.length) return null;
    // Prefer incomplete label, then pins / tiny spans, then closest start
    pool.sort((a, b) => {
      const aInc = a.incomplete || isIncompleteStepLabel(a.label) ? 0 : 1;
      const bInc = b.incomplete || isIncompleteStepLabel(b.label) ? 0 : 1;
      if (aInc !== bInc) return aInc - bInc;
      const aPin = a.pin || a.span <= 2 ? 0 : 1;
      const bPin = b.pin || b.span <= 2 ? 0 : 1;
      if (aPin !== bPin) return aPin - bPin;
      return (
        Math.abs(a.startFrame - wantStart) - Math.abs(b.startFrame - wantStart) ||
        b.left - a.left
      );
    });
    return pool[0];
  }

  function findStepRangeByNum(stepNum) {
    const want = Number(stepNum);
    if (!Number.isFinite(want)) return null;
    const matches = listTimelineSteps().filter((s) => s.stepNum === want && !s.incomplete);
    if (!matches.length) return null;
    // Prefer the widest / rightmost instance of that step id
    matches.sort((a, b) => b.width - a.width || b.end - a.end);
    return matches[0];
  }

  /** Rightmost/highest numbered step currently drawn — NOT incomplete / ontology last. */
  function findLastTimelineStepRange() {
    const steps = listTimelineSteps().filter(
      (s) => s.stepNum != null && !s.incomplete && (s.width >= 0.35 || !s.pin)
    );
    if (!steps.length) return null;
    const maxN = Math.max(...steps.map((s) => s.stepNum));
    return findStepRangeByNum(maxN);
  }

  function definedStepScrapeRoots() {
    return [
      document.querySelector('[data-testid="object-left-panel"]'),
      document.querySelector('[data-testid="editor-sider-top-pane"]'),
      document.querySelector('[data-testid="editor-sider-ontology-list"]')?.parentElement,
      document.querySelector('[data-testid="editor-sider"]'),
    ].filter(Boolean);
  }

  function parseStepNumFromText(raw) {
    const t = normalizeLabel(raw);
    if (!t) return null;
    // Prefer start-of-string; else first "step N" in the node (icons/hotkeys may prefix)
    const m = t.match(/^step\s*(\d+)\b/i) || t.match(/\bstep\s*(\d+)\b/i);
    if (!m) return null;
    const stepNum = Number(m[1]);
    return Number.isFinite(stepNum) ? { stepNum, label: t.slice(0, 160) } : null;
  }

  function isIncompleteStepLabel(raw) {
    return /^incomplete$/i.test(normalizeLabel(raw));
  }

  /**
   * Ontology Step options are an ordered list (tree / radio rows).
   * Numbered steps only — used for “last defined Step” (G1 end). Does not include
   * the trailing "incomplete" option used for S2.
   */
  function scrapeOrderedStepOptions(root) {
    if (!root) return [];
    const ordered = [];
    const seen = new Set();

    const push = (raw, el) => {
      if (!el || isInTimelineChrome(el) || isInLabelsPane(el)) return;
      const parsed = parseStepNumFromText(raw);
      if (!parsed || seen.has(parsed.stepNum)) return;
      seen.add(parsed.stepNum);
      ordered.push({
        stepNum: parsed.stepNum,
        label: parsed.label,
        order: ordered.length,
        el,
      });
    };

    // 1) Walk treeitems top → bottom (Encord Step option list)
    const treeItems = [...root.querySelectorAll('[role="treeitem"]')].filter((el) => {
      const style = el.getAttribute("style") || "";
      if (/display:\s*none/i.test(style)) return false;
      return !!el.querySelector("label.ant-radio-wrapper, label, .ant-radio");
    });
    for (const item of treeItems) {
      const title =
        item.querySelector(".ant-tree-title") ||
        item.querySelector("label.ant-radio-wrapper") ||
        item.querySelector("label");
      push(title?.textContent || item.textContent || "", item);
    }

    // 2) Fallback: radio labels in document order
    if (ordered.length < 2) {
      for (const el of root.querySelectorAll("label.ant-radio-wrapper, .ant-tree label")) {
        push(el.textContent || "", el);
      }
    }

    return ordered;
  }

  /**
   * Full Step selection array including trailing "incomplete" (last entry).
   * Used for S2 value — not for last-defined-step numbering.
   */
  function scrapeOrderedStepSelectionOptions(root) {
    if (!root) return [];
    const ordered = [];
    const seen = new Set();

    const push = (raw, el) => {
      if (!el || isInTimelineChrome(el) || isInLabelsPane(el)) return;
      const t = normalizeLabel(raw);
      if (!t || t.length > 200) return;
      const parsed = parseStepNumFromText(t);
      const incomplete = isIncompleteStepLabel(t);
      if (!parsed && !incomplete) return;
      const key = incomplete ? "incomplete" : `step-${parsed.stepNum}`;
      if (seen.has(key)) return;
      seen.add(key);
      ordered.push({
        stepNum: parsed?.stepNum ?? null,
        incomplete,
        label: (parsed?.label || t).slice(0, 160),
        order: ordered.length,
        el,
      });
    };

    const treeItems = [...root.querySelectorAll('[role="treeitem"]')].filter((el) => {
      const style = el.getAttribute("style") || "";
      if (/display:\s*none/i.test(style)) return false;
      return !!el.querySelector("label.ant-radio-wrapper, label, .ant-radio");
    });
    for (const item of treeItems) {
      const title =
        item.querySelector(".ant-tree-title") ||
        item.querySelector("label.ant-radio-wrapper") ||
        item.querySelector("label");
      push(title?.textContent || item.textContent || "", item);
    }

    if (ordered.length < 2) {
      for (const el of root.querySelectorAll("label.ant-radio-wrapper, .ant-tree label")) {
        push(el.textContent || "", el);
      }
    }

    return ordered;
  }

  function scrapeDefinedStepsFromUi() {
    const panel = document.querySelector('[data-testid="object-left-panel"]');
    const instance = normalizeLabel(
      document.querySelector('[data-testid="instance-name"]')?.textContent || ""
    ).toLowerCase();

    // Best source: Step instance panel with the full option array visible
    if (panel && instance === "step") {
      const fromPanel = scrapeOrderedStepOptions(panel);
      if (fromPanel.length >= 2) return fromPanel;
    }

    for (const root of definedStepScrapeRoots()) {
      const steps = scrapeOrderedStepOptions(root);
      if (steps.length >= 2) return steps;
    }
    return panel ? scrapeOrderedStepOptions(panel) : [];
  }

  /** Last defined Step = last entry in the ordered ontology options array. */
  function lastDefinedFromSteps(steps) {
    if (!Array.isArray(steps) || !steps.length) return null;
    return steps[steps.length - 1];
  }

  /** First defined Step = first entry in the ordered ontology options array (Step 1). */
  function firstDefinedFromSteps(steps) {
    if (!Array.isArray(steps) || !steps.length) return null;
    return steps[0];
  }

  function listTimelineStepsWithFrames(totalFrames = getTotalFrames()) {
    if (!totalFrames) return [];
    return listTimelineSteps()
      .map((s) => {
        const framed = withGradeFrames(s, totalFrames);
        return framed
          ? { ...framed, stepNum: s.stepNum, incomplete: !!s.incomplete }
          : null;
      })
      .filter(Boolean);
  }

  /** Step whose start is nearest to wantStart (optional stepNum / incomplete filter). */
  function findStepNearStart(
    wantStart,
    { stepNum = null, incomplete = false, totalFrames = getTotalFrames() } = {}
  ) {
    if (wantStart == null || !totalFrames) return null;
    let all = listTimelineStepsWithFrames(totalFrames);
    if (incomplete) {
      all = all.filter((s) => s.incomplete || isIncompleteStepLabel(s.label));
    } else if (stepNum != null) {
      all = all.filter((s) => s.stepNum === stepNum && !s.incomplete);
    }
    if (!all.length) return null;
    const tol = Math.max(BOUND_EPS, 2);
    const hits = all.filter((r) => Math.abs(r.startFrame - wantStart) <= tol);
    if (hits.length) {
      hits.sort(
        (a, b) =>
          Math.abs(a.startFrame - wantStart) - Math.abs(b.startFrame - wantStart) ||
          b.width - a.width
      );
      return hits[0];
    }
    const inTail = all.filter((r) => r.startFrame >= wantStart - tol);
    inTail.sort((a, b) => a.startFrame - b.startFrame);
    return inTail[0] || null;
  }

  function stepSelectionRoots() {
    return [
      document.querySelector('[data-testid="object-left-panel"]'),
      document.querySelector('[data-testid="editor-sider"]'),
      document.querySelector('[data-testid="editor-sider-ontology-list"]')?.parentElement,
      document.querySelector('[data-testid="editor-sider-top-pane"]'),
    ].filter(Boolean);
  }

  /**
   * S2 value = last Step option in the selection array ("incomplete").
   * Call with a Step instance selected so the value radios are visible.
   */
  function selectIncompleteStepOption() {
    for (const root of stepSelectionRoots()) {
      const opts = scrapeOrderedStepSelectionOptions(root);
      if (!opts.length) continue;
      const hit =
        opts.find((o) => o.incomplete || isIncompleteStepLabel(o.label)) ||
        opts[opts.length - 1];
      if (!hit) continue;
      const target =
        hit.el?.querySelector?.("label.ant-radio-wrapper, label, input[type='radio']") ||
        hit.el?.closest?.("label") ||
        hit.el;
      try {
        (target || hit.el).click();
        return {
          ok: true,
          via: "radio",
          label: hit.label,
          incomplete: !!hit.incomplete,
          options: opts.map((o) => o.label.slice(0, 40)),
        };
      } catch {
        /* try next root */
      }
    }
    // Same hotkey as Grade incomplete when the option is focused
    pressEditorKey("i");
    return { ok: true, via: "hotkey-i", label: "incomplete", incomplete: true, options: null };
  }

  async function applyIncompleteStepToRange(range) {
    if (!range?.el) return { ok: false, error: "no-range" };
    try {
      range.el.click();
    } catch {
      return { ok: false, error: "click-failed" };
    }
    await sleep(220);
    return selectIncompleteStepOption();
  }

  function activateStepClass() {
    const name = [...document.querySelectorAll('[data-testid="ontology-item-name"]')].find(
      (el) => normalizeLabel(el.textContent).toLowerCase() === "step"
    );
    if (name) {
      const btn = name.closest('[role="button"]') || name.parentElement || name;
      btn.click();
      return "ontology-item-name";
    }
    const aria = [...document.querySelectorAll('[role="button"][aria-label]')].find((el) => {
      if (isInTimelineChrome(el)) return false;
      return /^step$/i.test(el.getAttribute("aria-label") || "");
    });
    if (aria) {
      aria.click();
      return "aria";
    }
    return null;
  }

  async function persistDefinedSteps(payload) {
    try {
      const stored = await chrome.storage.local.get(STORAGE_DEFINED_STEPS);
      const map = stored[STORAGE_DEFINED_STEPS] && typeof stored[STORAGE_DEFINED_STEPS] === "object"
        ? stored[STORAGE_DEFINED_STEPS]
        : {};
      map[payload.projectKey] = {
        lastStepNum: payload.lastStepNum,
        steps: payload.steps,
        via: payload.via,
        updatedAt: Date.now(),
      };
      await chrome.storage.local.set({ [STORAGE_DEFINED_STEPS]: map });
    } catch {
      /* ignore */
    }
  }

  async function loadPersistedDefinedSteps(projectKey) {
    try {
      const stored = await chrome.storage.local.get(STORAGE_DEFINED_STEPS);
      const map = stored[STORAGE_DEFINED_STEPS];
      const hit = map?.[projectKey];
      if (hit && Number.isFinite(Number(hit.lastStepNum)) && Number(hit.lastStepNum) >= 1) {
        return {
          projectKey,
          lastStepNum: Number(hit.lastStepNum),
          steps: Array.isArray(hit.steps) ? hit.steps : [],
          via: hit.via || "storage",
        };
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  /**
   * Classes → Step: read ontology-defined Step options and cache the last id.
   * Does not use timeline annotations (those only show what's drawn so far).
   */
  async function discoverDefinedSteps({ force = false } = {}) {
    const projectKey = getProjectKey();
    const liveNow = scrapeDefinedStepsFromUi();
    const liveLast = lastDefinedFromSteps(liveNow);

    if (
      !force &&
      definedStepsCache &&
      definedStepsCache.projectKey === projectKey &&
      definedStepsCache.lastStepNum >= 1 &&
      (definedStepsCache.steps?.length || 0) >= 2 &&
      !(
        liveLast &&
        (liveLast.stepNum > definedStepsCache.lastStepNum ||
          liveNow.length > (definedStepsCache.steps?.length || 0))
      )
    ) {
      return definedStepsCache;
    }

    if (discoveringSteps) {
      for (let i = 0; i < 20; i += 1) {
        await sleep(50);
        if (!discoveringSteps && definedStepsCache?.projectKey === projectKey) {
          return definedStepsCache;
        }
      }
    }

    discoveringSteps = true;
    try {
      // 1) Passive scrape — best when Step options panel is already open
      let steps = liveNow.length >= 2 ? liveNow : scrapeDefinedStepsFromUi();
      let via = liveNow.length >= 2 ? "passive-panel" : "passive";

      // 2) Open Classes → Step when list looks incomplete
      if (steps.length < 2) {
        const activated = activateStepClass();
        if (activated) {
          await sleep(350);
          steps = scrapeDefinedStepsFromUi();
          via = "classes-step";
          pressEditorKey("Escape");
          await sleep(80);
        }
      }

      // 3) Persist fuller live lists over a bad thin cache (e.g. last=2 when ontology has 4)
      const persisted = await loadPersistedDefinedSteps(projectKey);
      if (steps.length < 2) {
        if (persisted && (persisted.steps?.length || 0) >= 2) {
          definedStepsCache = persisted;
          return definedStepsCache;
        }
        definedStepsCache = null;
        return null;
      }

      const last = lastDefinedFromSteps(steps);
      if (!last) {
        definedStepsCache = null;
        return null;
      }
      if (
        persisted &&
        (persisted.steps?.length || 0) > steps.length &&
        persisted.lastStepNum > last.stepNum
      ) {
        definedStepsCache = persisted;
        return definedStepsCache;
      }

      definedStepsCache = {
        projectKey,
        lastStepNum: last.stepNum,
        steps,
        via,
      };
      await persistDefinedSteps(definedStepsCache);
      return definedStepsCache;
    } finally {
      discoveringSteps = false;
    }
  }

  async function ensureDefinedLastStep() {
    const projectKey = getProjectKey();
    if (
      definedStepsCache &&
      definedStepsCache.projectKey === projectKey &&
      definedStepsCache.lastStepNum >= 1
    ) {
      return definedStepsCache;
    }
    const persisted = await loadPersistedDefinedSteps(projectKey);
    if (persisted) {
      definedStepsCache = persisted;
      // Refresh in background if possible
      discoverDefinedSteps({ force: true }).catch(() => {});
      return definedStepsCache;
    }
    return discoverDefinedSteps({ force: false });
  }

  function findLastStepRange() {
    // Prefer ontology-defined last Step once known; else timeline max (manual/legacy).
    if (
      definedStepsCache &&
      definedStepsCache.projectKey === getProjectKey() &&
      definedStepsCache.lastStepNum >= 1
    ) {
      return findStepRangeByNum(definedStepsCache.lastStepNum);
    }
    return findLastTimelineStepRange();
  }

  function isGradeLabel(label) {
    const t = normalizeLabel(label).toLowerCase();
    return !t || t === "grade" || /^grade\b/.test(t);
  }

  function withGradeFrames(range, totalFrames) {
    if (!range || !totalFrames) return null;
    // Re-read CSS when we have an element — callers often pass stale startFrame/endFrame.
    const live = range.el ? describeRange(range.el) || range : range;
    const startFrame = pctToFrame(live.left, totalFrames);
    const endFrame = pctToEndFrame(live.end, totalFrames);
    return {
      ...live,
      el: range.el || live.el,
      startFrame,
      endFrame,
      span: endFrame - startFrame,
    };
  }

  function listGradeRanges() {
    return listRanges("row-trajectory").filter((r) => isGradeLabel(r.label));
  }

  function listGradeRangesWithFrames(totalFrames = getTotalFrames()) {
    if (!totalFrames) return [];
    return listGradeRanges()
      .map((r) => withGradeFrames(r, totalFrames))
      .filter(Boolean);
  }

  /** Prefer the Grade spanning from frame 0 (main sync); else widest. */
  function findPrimaryGradeRange() {
    const total = getTotalFrames();
    const all = listGradeRangesWithFrames(total);
    if (!all.length) {
      const any = listRanges("row-trajectory");
      if (!any.length) return null;
      any.sort((a, b) => b.width - a.width);
      return withGradeFrames(any[0], total) || any[0];
    }
    const fromZero = all.filter((r) => r.startFrame <= BOUND_EPS + 1);
    const pool = fromZero.length ? fromZero : all;
    const spans = pool.filter((r) => !r.pin && r.width >= 0.35);
    if (spans.length) {
      spans.sort((a, b) => b.width - a.width);
      return spans[0];
    }
    pool.sort((a, b) => b.width - a.width || b.left - a.left);
    return pool[0];
  }

  /** Grade whose start is nearest to wantStart (for the post-last-step tail). */
  function findGradeNearStart(wantStart, totalFrames = getTotalFrames()) {
    if (wantStart == null || !totalFrames) return null;
    const all = listGradeRangesWithFrames(totalFrames);
    if (!all.length) return null;
    const tol = Math.max(BOUND_EPS, 2);
    // When looking for a tail, never return the primary (starts at ~0).
    const pool =
      wantStart > 1 ? all.filter((r) => (r.startFrame ?? 0) > 1) : all;
    if (!pool.length) return null;
    const hits = pool.filter((r) => Math.abs(r.startFrame - wantStart) <= tol);
    if (hits.length) {
      hits.sort(
        (a, b) =>
          Math.abs(a.startFrame - wantStart) - Math.abs(b.startFrame - wantStart) ||
          b.width - a.width
      );
      return hits[0];
    }
    const inTail = pool.filter((r) => r.startFrame >= wantStart - tol);
    inTail.sort((a, b) => a.startFrame - b.startFrame);
    return inTail[0] || null;
  }

  function episodeLastFrame(totalFrames = getTotalFrames()) {
    if (!totalFrames) return null;
    // Encord's totalFrames label is the last frame index (not count-1).
    // Targeting total-1 left G2 permanently one frame short of episode end.
    return totalFrames;
  }

  /**
   * Extend only the right edge of an existing Grade to wantEnd (no Fill / start writes).
   * Used after G1 restore, which often leaves G2 at episodeEnd - 1.
   */
  async function extendGradeEndOnly(preferRange, wantEnd, { matchStart } = {}) {
    const total = getTotalFrames();
    const targetEnd = Math.min(
      Math.max(0, Math.floor(wantEnd)),
      total || Math.floor(wantEnd)
    );
    let active =
      (preferRange?.el && withGradeFrames(describeRange(preferRange.el) || preferRange, total)) ||
      findGradeNearStart(matchStart ?? preferRange?.startFrame, total);
    if (!active?.el) return { ok: false, error: "no-grade-to-extend" };

    // Refuse to extend the primary when caller intended a tail instance.
    if (matchStart > 1 && (active.startFrame ?? 0) <= 1) {
      return { ok: false, error: "extend-resolved-to-primary" };
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        active.el.click();
      } catch {
        return { ok: false, error: "click-failed" };
      }
      await sleep(160);
      const geo = timelineBounds(active);
      if (!geo) return { ok: false, error: "no-geo" };
      if (Math.abs(geo.endFrame - targetEnd) <= BOUND_EPS) {
        // Also confirm Range end input when present — CSS can lag or lie near 100%.
        const bounds = findRangeBoundInputs();
        const endVal = bounds
          ? Number(String(bounds.end.value || "").replace(/[^\d]/g, ""))
          : null;
        if (endVal == null || !Number.isFinite(endVal) || Math.abs(endVal - targetEnd) <= BOUND_EPS) {
          return { ok: true, after: geo, attempts: attempt + 1, endVal };
        }
      }
      if (geo.endFrame > targetEnd) {
        adjustRightSide(targetEnd - geo.endFrame);
        await sleep(120);
      } else {
        const shortBy = Math.max(1, Math.min(4, targetEnd - geo.endFrame));
        adjustRightSide(shortBy);
        await sleep(120);
      }
      const bounds = findRangeBoundInputs();
      if (bounds) {
        // Keep start; only rewrite end so we don't disturb G1 abutment.
        await setInputFrame(bounds.end, targetEnd);
        await sleep(140);
      }
      // Fill to playhead at target end as a last push for episode-end shorts
      if (attempt >= 1) {
        const jumped = await goToFrame(targetEnd);
        await sleep(60);
        try {
          active.el.click();
        } catch {
          /* ignore */
        }
        await sleep(100);
        if (jumped.ok) {
          clickFillToPlayhead();
          await sleep(220);
        } else if (total && targetEnd >= total - 1) {
          // Jump to last navigable frame then nudge end past it via inputs/adjust
          await goToFrame(Math.max(0, total - 1));
          await sleep(60);
          try {
            active.el.click();
          } catch {
            /* ignore */
          }
          await sleep(80);
          clickFillToPlayhead();
          await sleep(200);
          adjustRightSide(1);
          await sleep(100);
        }
        const bounds2 = findRangeBoundInputs();
        if (bounds2) {
          const startKeep = Number(String(bounds2.start.value || "").replace(/[^\d]/g, ""));
          if (Number.isFinite(startKeep)) await setInputFrame(bounds2.start, startKeep);
          await setInputFrame(bounds2.end, targetEnd);
          await sleep(140);
        }
      }
      active =
        findGradeNearStart(matchStart ?? active.startFrame, total) ||
        (active.el ? withGradeFrames(describeRange(active.el) || active, total) : null) ||
        active;
    }

    const finalGeo = timelineBounds(
      findGradeNearStart(matchStart ?? preferRange?.startFrame, total) || preferRange
    );
    const boundsFinal = findRangeBoundInputs();
    const endVal = boundsFinal
      ? Number(String(boundsFinal.end.value || "").replace(/[^\d]/g, ""))
      : null;
    const okGeo = finalGeo && Math.abs(finalGeo.endFrame - targetEnd) <= BOUND_EPS;
    const okInput = endVal != null && Number.isFinite(endVal) && Math.abs(endVal - targetEnd) <= BOUND_EPS;
    return {
      ok: !!(okGeo || okInput),
      after: finalGeo,
      wantEnd: targetEnd,
      endVal,
      error: okGeo || okInput ? undefined : "extend-end-failed",
    };
  }

  function pctToFrame(pct, totalFrames) {
    if (!totalFrames) return 0;
    // Same basis as the playhead: frame N sits at (N / totalFrames) * 100%.
    return Math.max(0, Math.min(totalFrames, Math.round((Number(pct) / 100) * totalFrames)));
  }

  /** Inclusive range end (clamped to episode last frame = totalFrames). */
  function pctToEndFrame(pct, totalFrames) {
    if (!totalFrames) return 0;
    const raw = (Number(pct) / 100) * totalFrames;
    // Near-integer float noise (435.9999) → round to that frame.
    // Allow totalFrames itself — a bar at 100% is the episode last frame.
    return Math.max(0, Math.min(totalFrames, Math.round(raw)));
  }

  function setNativeInputValue(input, value) {
    const proto = window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function ensurePageWorld() {
    if (document.documentElement.dataset.encordGradePw === VERSION) return;
    const existing = document.getElementById("encord-grade-page-world");
    if (existing) existing.remove();
    const s = document.createElement("script");
    s.id = "encord-grade-page-world";
    s.src = chrome.runtime.getURL("page-world.js");
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
    document.documentElement.dataset.encordGradePw = VERSION;
  }

  function pageGotoFrame(frame) {
    ensurePageWorld();
    const id = `goto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMsg);
        resolve({ ok: false, error: "goto-timeout" });
      }, 2500);
      function onMsg(event) {
        if (event.source !== window) return;
        const data = event.data;
        if (data?.source !== "encord-grade-sync" || data.type !== "GOTO_FRAME_RESULT" || data.id !== id) {
          return;
        }
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        resolve(data.result || { ok: false, error: "empty-goto-result" });
      }
      window.addEventListener("message", onMsg);
      // Give the script a tick to load on first inject
      setTimeout(() => {
        window.postMessage(
          { source: "encord-grade-sync", type: "GOTO_FRAME", id, frame },
          "*"
        );
      }, 50);
    });
  }

  async function goToFrame(frame) {
    const target = Math.max(0, Math.floor(frame));

    // 1) MAIN-world React path
    let result = await pageGotoFrame(target);
    for (let i = 0; i < 15; i += 1) {
      await sleep(40);
      const cur = getCurrentFrame();
      if (cur != null && Math.abs(cur - target) <= FRAME_EPS) {
        return { ok: true, frame: cur, via: "page-world" };
      }
    }

    // 2) DOM/Ant input fallback
    const input = document.querySelector('[data-testid="content-navigation-frame-input"]');
    if (input) {
      input.focus();
      await sleep(20);
      input.select?.();
      setNativeInputValue(input, String(target));
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
      );
      input.blur();
      for (let i = 0; i < 15; i += 1) {
        await sleep(40);
        const cur = getCurrentFrame();
        if (cur != null && Math.abs(cur - target) <= FRAME_EPS) {
          return { ok: true, frame: cur, via: "dom-input" };
        }
      }
    }

    // 3) Slider click by percentage
    const total = getTotalFrames();
    const slider = document.querySelector('[data-testid="content-navigation-slider"]');
    if (slider && total) {
      const rect = slider.getBoundingClientRect();
      const x = rect.left + (target / Math.max(1, total - 1)) * rect.width;
      const y = rect.top + rect.height / 2;
      const el = document.elementFromPoint(x, y) || slider;
      el.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window })
      );
      for (let i = 0; i < 15; i += 1) {
        await sleep(40);
        const cur = getCurrentFrame();
        if (cur != null && Math.abs(cur - target) <= Math.max(FRAME_EPS, 2)) {
          return { ok: true, frame: cur, via: "slider" };
        }
      }
    }

    return {
      ok: false,
      error: "goto-unverified",
      frame: getCurrentFrame(),
      target,
      page: result,
    };
  }

  function pressEditorKey(key, { altKey = false, shiftKey = false, metaKey = false } = {}) {
    const raw = String(key);
    const lower = raw.toLowerCase();
    const arrow =
      lower === "arrowleft" || lower === "left"
        ? "ArrowLeft"
        : lower === "arrowright" || lower === "right"
          ? "ArrowRight"
          : lower === "arrowup" || lower === "up"
            ? "ArrowUp"
            : lower === "arrowdown" || lower === "down"
              ? "ArrowDown"
              : null;
    const code = arrow
      ? arrow
      : lower.length === 1 && lower >= "a" && lower <= "z"
        ? `Key${lower.toUpperCase()}`
        : lower === "enter"
          ? "Enter"
          : lower === "escape"
            ? "Escape"
            : lower === "backspace"
              ? "Backspace"
              : lower === "delete"
                ? "Delete"
                : `Key${lower.toUpperCase()}`;
    const keyCode = arrow
      ? arrow === "ArrowLeft"
        ? 37
        : arrow === "ArrowUp"
          ? 38
          : arrow === "ArrowRight"
            ? 39
            : 40
      : lower === "enter"
        ? 13
        : lower === "escape"
          ? 27
          : lower === "backspace"
            ? 8
            : lower === "delete"
              ? 46
              : lower.toUpperCase().charCodeAt(0);
    const opts = {
      key: arrow
        ? arrow
        : lower === "escape"
          ? "Escape"
          : lower.length === 1
            ? lower
            : raw,
      code,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      altKey,
      shiftKey,
      metaKey,
      ctrlKey: false,
    };

    const focusTarget =
      document.querySelector('[data-testid="classification-timeline"]') ||
      document.querySelector('[data-testid="editor-video-tool"]') ||
      document.body;
    try {
      focusTarget.focus?.();
    } catch {
      /* ignore */
    }

    for (const target of [document.activeElement, focusTarget, document.body, window].filter(Boolean)) {
      target.dispatchEvent(new KeyboardEvent("keydown", opts));
      target.dispatchEvent(new KeyboardEvent("keyup", opts));
    }
  }

  function findControlByText(patterns, { root = document } = {}) {
    const list = Array.isArray(patterns) ? patterns : [patterns];
    const nodes = [
      ...root.querySelectorAll(
        "button, [role='button'], [role='menuitem'], a, div.ant-btn, span.ant-btn, label"
      ),
    ];
    for (const re of list) {
      const hit = nodes.find((el) => {
        const t = normalizeLabel(el.textContent || el.getAttribute("aria-label") || "");
        return t.length < 64 && re.test(t);
      });
      if (hit) return hit;
    }
    // Encord action rows often use a bare <span>Fill to playhead</span> inside a clickable row
    const spans = [...root.querySelectorAll("span, div, li")];
    for (const re of list) {
      const leaf = spans.find((el) => {
        const t = normalizeLabel(el.textContent || el.getAttribute("aria-label") || "");
        if (!(t.length > 0 && t.length < 48 && re.test(t))) return false;
        // Prefer the tightest match (avoid huge panels)
        return el.childElementCount <= 2;
      });
      if (!leaf) continue;
      const clickable =
        leaf.closest("button, [role='button'], [role='menuitem'], a, label") ||
        leaf.closest("[class*='action'], [class*='Action'], [data-testid]") ||
        leaf.parentElement ||
        leaf;
      return clickable;
    }
    return null;
  }

  function clickControlByText(patterns, opts) {
    const hit = findControlByText(patterns, opts);
    if (!hit) return null;
    hit.click();
    return normalizeLabel(hit.textContent || hit.getAttribute("aria-label") || "clicked");
  }

  function classificationToolbarReady() {
    return !!findControlByText([
      /set start to current/i,
      /set start to this/i,
      /^set start$/i,
      /set end to current/i,
      /^add range$/i,
    ]);
  }

  function tileShellFor(el) {
    if (!(el instanceof Element)) return null;
    return el.closest(".mosaic-window") || el.closest(".mosaic-tile") || null;
  }

  function isSubstantialTile(el) {
    const shell = tileShellFor(el) || el;
    if (!(shell instanceof Element)) return false;
    const r = shell.getBoundingClientRect();
    return r.width >= 120 && r.height >= 120;
  }

  function normalizeTileId(text) {
    return normalizeLabel(text)
      .toLowerCase()
      .replace(/[-\s]+/g, "_");
  }

  /**
   * Resolve the mosaic shell Grade should bind to.
   * Never use the first tile-display-name in DOM order — that is often a wrist cam
   * (e.g. other_3) while Annotate/Current sits on cam_high / other_4.
   */
  function findPreferredGradeTileShell() {
    const want = normalizeTileId(PREFERRED_GRADE_TILE);

    for (const nameEl of document.querySelectorAll('[data-testid="tile-display-name"]')) {
      if (normalizeTileId(nameEl.textContent) !== want) continue;
      if (!isSubstantialTile(nameEl)) continue;
      return tileShellFor(nameEl) || nameEl;
    }

    const byToolbar =
      document.querySelector(`[data-testid="main-toolbar-${CSS.escape(PREFERRED_GRADE_TILE)}"]`) ||
      document.querySelector(`[data-testid="secondary-toolbar-${CSS.escape(PREFERRED_GRADE_TILE)}"]`);
    if (byToolbar && isSubstantialTile(byToolbar)) {
      return tileShellFor(byToolbar) || byToolbar;
    }

    const byTag = document.querySelector(`[data-tile-id-tag="${CSS.escape(PREFERRED_GRADE_TILE)}"]`);
    if (byTag && isSubstantialTile(byTag)) {
      return tileShellFor(byTag) || byTag;
    }

    // Media URL still carries cam_high even when the UI label is other_N.
    for (const el of document.querySelectorAll("video, source, [src], [data-src]")) {
      const src = el.getAttribute("src") || el.getAttribute("data-src") || "";
      if (!src) continue;
      if (
        !src.includes(`/${PREFERRED_GRADE_TILE}/`) &&
        !src.includes(`cam_${PREFERRED_GRADE_TILE}`) &&
        !new RegExp(`(^|/)${PREFERRED_GRADE_TILE}(/|_|\\.|$)`).test(src)
      ) {
        continue;
      }
      if (!isSubstantialTile(el)) continue;
      return tileShellFor(el) || el;
    }

    // Fall back: whatever tile is currently active for Annotate.
    const modeTag = document.querySelector('[data-testid="editor-mode-status-tag"]');
    if (modeTag && isSubstantialTile(modeTag)) {
      return tileShellFor(modeTag) || modeTag;
    }

    const currentTag = document.querySelector('[data-testid="current-tile-tag-left-sidebar"]');
    const group = currentTag?.closest?.('[data-testid^="data-group-tile-labels-"]');
    const groupId = group?.getAttribute("data-testid") || "";
    const tileId = groupId.replace(/^data-group-tile-labels-/i, "");
    if (tileId) {
      for (const nameEl of document.querySelectorAll('[data-testid="tile-display-name"]')) {
        if (normalizeTileId(nameEl.textContent) !== normalizeTileId(tileId)) continue;
        if (!isSubstantialTile(nameEl)) continue;
        return tileShellFor(nameEl) || nameEl;
      }
      const tb =
        document.querySelector(`[data-testid="main-toolbar-${CSS.escape(tileId)}"]`) ||
        document.querySelector(`[data-testid="secondary-toolbar-${CSS.escape(tileId)}"]`);
      if (tb && isSubstantialTile(tb)) return tileShellFor(tb) || tb;
    }

    return null;
  }

  function clickEl(el) {
    if (!el) return false;
    try {
      el.click();
      return true;
    } catch {
      return false;
    }
  }

  async function focusPreferredGradeTile() {
    const shell = findPreferredGradeTileShell();
    if (!shell) return null;
    const target =
      shell.querySelector?.('[data-testid="tile-display-name"]') ||
      shell.querySelector?.('[data-testid="editor-content"]') ||
      shell.querySelector?.("video") ||
      shell.querySelector?.('[data-testid="canvas"]') ||
      shell;
    clickEl(target);
    await sleep(40);
    clickEl(target);
    return shell;
  }

  /**
   * Deselect instances via UI clicks. Synthetic Escape is often ignored
   * (isTrusted=false), which leads to "Cannot change class…".
   * Focus preferred camera first — Grade binds to the active tile.
   */
  async function clearInstanceSelection() {
    const shell = await focusPreferredGradeTile();
    await sleep(40);

    const modeTag =
      shell?.querySelector?.('[data-testid="editor-mode-status-tag"]') ||
      document.querySelector('[data-testid="editor-mode-status-tag"]');
    clickEl(modeTag);
    await sleep(40);

    const canvas =
      shell?.querySelector?.('[data-testid="canvas"]') ||
      shell?.querySelector?.('[data-testid="editor-content"]') ||
      (shell
        ? null
        : document.querySelector('[data-testid="canvas"]') ||
          document.querySelector('[data-testid="editor-content"]'));
    if (canvas) {
      const r = canvas.getBoundingClientRect();
      const x = r.left + Math.min(24, r.width / 2);
      const y = r.top + Math.min(24, r.height / 2);
      const topEl = document.elementFromPoint(x, y) || canvas;
      topEl.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y, view: window })
      );
      topEl.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y, view: window })
      );
      topEl.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientX: x, clientY: y, view: window })
      );
    }
    await sleep(60);
    pressEditorKey("Escape");
    await sleep(40);
  }

  function activateTrajectoryClass() {
    // Only Classes list — never left timeline row (that can mean "change class")
    const name = [...document.querySelectorAll('[data-testid="ontology-item-name"]')].find(
      (el) => normalizeLabel(el.textContent).toLowerCase() === "trajectory"
    );
    if (name) {
      const btn = name.closest('[role="button"]') || name.parentElement || name;
      btn.click();
      return "ontology-item-name";
    }
    const aria = [...document.querySelectorAll('[role="button"][aria-label]')].find((el) =>
      /^trajectory$/i.test(el.getAttribute("aria-label") || "")
    );
    if (aria && !aria.closest('[data-testid="classification-timeline"]')) {
      aria.click();
      return "aria";
    }
    return null;
  }

  /**
   * Grade value radios under Trajectory → Grade (DOM order), e.g.
   * -1, 0, 1, 3, 4, 5, incomplete. Last entry is "incomplete".
   */
  function scrapeOrderedGradeValueOptions(root) {
    if (!root) return [];
    const ordered = [];
    const seen = new Set();

    const push = (raw, el) => {
      if (!el || isInTimelineChrome(el) || isInLabelsPane(el)) return;
      const t = normalizeLabel(raw);
      if (!t || t.length > 24) return;
      if (/^grade$/i.test(t) || /^step\b/i.test(t) || /^trajectory$/i.test(t)) return;
      if (!/^-?\d+$/.test(t) && !/^incomplete$/i.test(t)) return;
      const key = t.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      ordered.push({ label: t, el, order: ordered.length });
    };

    const treeItems = [...root.querySelectorAll('[role="treeitem"]')].filter((el) => {
      const style = el.getAttribute("style") || "";
      if (/display:\s*none/i.test(style)) return false;
      return !!el.querySelector("label.ant-radio-wrapper, label, .ant-radio");
    });
    for (const item of treeItems) {
      const title =
        item.querySelector(".ant-tree-title") ||
        item.querySelector("label.ant-radio-wrapper") ||
        item.querySelector("label");
      push(title?.textContent || item.textContent || "", item);
    }

    if (ordered.length < 2) {
      for (const el of root.querySelectorAll("label.ant-radio-wrapper, .ant-tree label")) {
        push(el.textContent || "", el);
      }
    }

    return ordered;
  }

  /**
   * G2 (post-last-step tail) must use the last Grade option = "incomplete".
   * Call with a Grade instance selected so the value radios are visible.
   */
  function selectIncompleteGradeOption() {
    const panel = document.querySelector('[data-testid="object-left-panel"]');
    const roots = [
      panel,
      document.querySelector('[data-testid="editor-sider"]'),
      document.querySelector('[data-testid="editor-sider-ontology-list"]')?.parentElement,
    ].filter(Boolean);

    for (const root of roots) {
      const opts = scrapeOrderedGradeValueOptions(root);
      if (!opts.length) continue;
      const hit =
        opts.find((o) => /^incomplete$/i.test(o.label)) || opts[opts.length - 1];
      if (!hit) continue;
      const target =
        hit.el?.querySelector?.("label.ant-radio-wrapper, label, input[type='radio']") ||
        hit.el?.closest?.("label") ||
        hit.el;
      try {
        (target || hit.el).click();
        return {
          ok: true,
          via: "radio",
          label: hit.label,
          options: opts.map((o) => o.label),
        };
      } catch {
        /* try next root */
      }
    }

    // Screenshot hotkey for incomplete is I
    pressEditorKey("i");
    return { ok: true, via: "hotkey-i", label: "incomplete", options: null };
  }

  async function applyIncompleteGradeToRange(range) {
    if (!range?.el) return { ok: false, error: "no-range" };
    try {
      range.el.click();
    } catch {
      return { ok: false, error: "click-failed" };
    }
    await sleep(220);
    return selectIncompleteGradeOption();
  }

  /** Find editable Range start / Range end inputs (instance edit panel). */
  function findRangeBoundInputs() {
    // Exact aria labels from Encord object-left-panel (screenshot + DOM scan)
    const start = document.querySelector('input[aria-label="Range start"]');
    const end = document.querySelector('input[aria-label="Range end"]');
    if (start && end) {
      const r0 = start.getBoundingClientRect();
      const r1 = end.getBoundingClientRect();
      if (r0.width > 0 && r1.width > 0) return { start, end, via: "aria-range" };
    }

    const inputs = [...document.querySelectorAll("input")].filter((el) => {
      if (el.disabled || el.type === "hidden") return false;
      if (el.getAttribute("data-testid") === "content-navigation-frame-input") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

    const byAriaStart = inputs.find((el) => /range\s*start/i.test(el.getAttribute("aria-label") || ""));
    const byAriaEnd = inputs.find((el) => /range\s*end/i.test(el.getAttribute("aria-label") || ""));
    if (byAriaStart && byAriaEnd) return { start: byAriaStart, end: byAriaEnd, via: "aria-fuzzy" };

    const panel = document.querySelector('[data-testid="object-left-panel"]');
    if (panel) {
      const panelInputs = inputs.filter((el) => panel.contains(el));
      if (panelInputs.length >= 2) {
        return { start: panelInputs[0], end: panelInputs[1], via: "object-left-panel" };
      }
    }

    return null;
  }

  async function setInputFrame(input, frame) {
    const val = String(Math.max(0, Math.floor(frame)));
    const aria = input.getAttribute("aria-label") || "";

    // Prefer MAIN-world React onChange so Encord state commits (DOM-only value can lie).
    if (aria) {
      const page = await pageSetRangeInput(aria, Number(val));
      await sleep(100);
      const live = document.querySelector(`input[aria-label="${aria}"]`) || input;
      if (String(live.value || "").replace(/[^\d]/g, "") === val) {
        // Commit: Enter + blur (Ant often applies onPressEnter / onBlur)
        try {
          live.focus();
          live.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Enter",
              code: "Enter",
              keyCode: 13,
              bubbles: true,
              cancelable: true,
            })
          );
          live.dispatchEvent(
            new KeyboardEvent("keyup", {
              key: "Enter",
              code: "Enter",
              keyCode: 13,
              bubbles: true,
              cancelable: true,
            })
          );
          live.blur();
        } catch {
          /* ignore */
        }
        await sleep(80);
        return { ok: true, via: "react", page };
      }
    }

    input.focus();
    await sleep(30);
    try {
      input.select();
    } catch {
      /* ignore */
    }
    setNativeInputValue(input, "");
    await sleep(15);
    setNativeInputValue(input, val);
    try {
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          data: val,
          inputType: "insertReplacementText",
        })
      );
    } catch {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
    );
    input.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
    );
    input.blur();
    await sleep(100);

    const live = document.querySelector(`input[aria-label="${aria}"]`) || input;
    const committed = String(live.value || "").replace(/[^\d]/g, "");
    return { ok: committed === val, via: "dom", value: committed, want: val };
  }

  function pageSetRangeInput(ariaLabel, frame) {
    ensurePageWorld();
    const id = `range-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMsg);
        resolve({ ok: false, error: "range-set-timeout" });
      }, 2000);
      function onMsg(event) {
        if (event.source !== window) return;
        const data = event.data;
        if (data?.source !== "encord-grade-sync" || data.type !== "SET_RANGE_RESULT" || data.id !== id) {
          return;
        }
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        resolve(data.result || { ok: false });
      }
      window.addEventListener("message", onMsg);
      setTimeout(() => {
        window.postMessage(
          { source: "encord-grade-sync", type: "SET_RANGE_INPUT", id, ariaLabel, frame },
          "*"
        );
      }, 40);
    });
  }

  function clickDoneIfPresent() {
    const panel = document.querySelector('[data-testid="object-left-panel"]')?.parentElement ||
      document.querySelector('[data-testid="editor-sider"]');
    const root = panel || document;
    return clickControlByText([/^done$/i, /^done\s*esc$/i], { root });
  }

  /**
   * After Grade bounds are set: blur Range start/end so grade hotkeys don't
   * type into the frame fields. Keep the Grade instance selected.
   */
  async function blurRangeFrameInputs() {
    try {
      document.querySelector('input[aria-label="Range end"]')?.blur?.();
      document.querySelector('input[aria-label="Range start"]')?.blur?.();
      const active = document.activeElement;
      if (
        active &&
        active.matches?.(
          'input[aria-label="Range start"], input[aria-label="Range end"]'
        )
      ) {
        active.blur?.();
      }
    } catch {
      /* ignore */
    }
    // Focus a non-input chrome so the next keypress isn't captured by an input
    const focusTarget =
      document.querySelector('[data-testid="instance-name"]') ||
      document.querySelector('[data-testid="object-left-panel"]') ||
      document.querySelector('[data-testid="classification-timeline"]');
    try {
      if (focusTarget) {
        if (focusTarget.tabIndex < 0) focusTarget.tabIndex = -1;
        focusTarget.focus?.({ preventScroll: true });
      }
    } catch {
      /* ignore */
    }
    await sleep(40);
  }

  function actionsRoot() {
    return (
      document.querySelector('[data-testid="available-actions-panel"]') ||
      document.querySelector('[data-testid="object-left-panel"]')?.parentElement ||
      document
    );
  }

  function clickFillToPlayhead() {
    const root = actionsRoot();
    // Prefer the exact action label leaf (often a bare <span>)
    const leaf = [...(root || document).querySelectorAll("span, button, [role='button']")].find(
      (el) => normalizeLabel(el.textContent).toLowerCase() === "fill to playhead"
    );
    if (leaf) {
      const target =
        leaf.closest("button, [role='button'], [role='menuitem']") ||
        leaf.parentElement ||
        leaf;
      try {
        target.click();
        return "fill-to-playhead";
      } catch {
        /* fall through */
      }
    }
    const hit =
      clickControlByText([/fill to playhead/i], { root }) ||
      clickControlByText([/fill to playhead/i]);
    if (hit) return hit;
    // ⌥V
    pressEditorKey("v", { altKey: true });
    return "alt-v";
  }

  /** ⌥← / ⌥→ — Adjust right side (end edge) by one frame each. */
  function adjustRightSide(steps) {
    const n = Math.trunc(steps);
    if (!n) return;
    const key = n < 0 ? "ArrowLeft" : "ArrowRight";
    for (let i = 0; i < Math.abs(n); i += 1) {
      pressEditorKey(key, { altKey: true });
    }
  }

  /** ⌥⇧← / ⌥⇧→ — Adjust left side (start edge) by one frame each. */
  function adjustLeftSide(steps) {
    const n = Math.trunc(steps);
    if (!n) return;
    const key = n < 0 ? "ArrowLeft" : "ArrowRight";
    for (let i = 0; i < Math.abs(n); i += 1) {
      pressEditorKey(key, { altKey: true, shiftKey: true });
    }
  }

  function timelineBounds(preferRange = null) {
    const total = getTotalFrames();
    let grade = preferRange || findPrimaryGradeRange();
    if (!grade || !total) return null;
    // Always re-derive from live CSS — preferRange may carry stale startFrame/endFrame.
    if (grade.el) {
      const live = describeRange(grade.el);
      grade = live ? withGradeFrames(live, total) : withGradeFrames(grade, total);
    } else if (grade.startFrame == null || grade.endFrame == null) {
      grade = withGradeFrames(grade, total);
    }
    if (!grade) return null;
    return {
      startFrame: grade.startFrame,
      endFrame: grade.endFrame,
      span: grade.span,
      total,
      el: grade.el,
    };
  }

  function timelineMatches(wantStart, wantEnd, preferRange = null) {
    const t = timelineBounds(preferRange);
    if (!t) return false;
    return (
      Math.abs(t.startFrame - wantStart) <= BOUND_EPS &&
      Math.abs(t.endFrame - wantEnd) <= BOUND_EPS
    );
  }

  /**
   * Commit real timeline geometry. Zero-width pins ignore Range inputs (fields can
   * show 0–810 while the bar stays 827–827). Order:
   * 1) Fill-to-playhead at wantStart and at wantEnd (creates a real span)
   * 2) Range inputs for exact values
   * 3) ⌥-arrow Adjust left/right to nudge remaining error
   * Success requires the timeline bar to match — never inputs-only.
   *
   * opts.lockToSelectRange: when resizing a non-primary Grade (tail), never fall
   * back to the primary 0…last-step instance — that was shrinking G1 by 1 when G2
   * Fill/inputs landed on the wrong bar.
   */
  async function resizeViaRangeInputs(startFrame, endFrame, opts = {}) {
    const totalLive = getTotalFrames();
    let wantStart = Math.max(0, Math.floor(startFrame));
    let wantEnd = Math.max(wantStart, Math.floor(endFrame));
    if (totalLive) {
      // Last frame index == totalFrames (not total-1); G2 must be able to reach it.
      wantEnd = Math.min(wantEnd, totalLive);
      wantStart = Math.min(wantStart, wantEnd);
    }
    const matchStart = opts.matchStart != null ? opts.matchStart : wantStart;
    // Tail / non-zero start: never rewrite the primary Grade by accident.
    const lockTail = opts.lockToSelectRange === true || matchStart > 1;

    function refreshActive() {
      // Locked resize (G2 / Step tail): stay on the provided instance — never
      // jump to a Grade that shares the same start frame.
      if (lockTail && opts.selectRange?.el?.isConnected) {
        const live = describeRange(opts.selectRange.el);
        return live
          ? withGradeFrames(live, getTotalFrames())
          : withGradeFrames(opts.selectRange, getTotalFrames());
      }
      const near = findGradeNearStart(matchStart, getTotalFrames());
      if (near) return near;
      if (opts.selectRange?.el?.isConnected) {
        const live = describeRange(opts.selectRange.el);
        return live
          ? withGradeFrames(live, getTotalFrames())
          : withGradeFrames(opts.selectRange, getTotalFrames());
      }
      if (lockTail) return null;
      return findPrimaryGradeRange();
    }

    let active = opts.selectRange || refreshActive();

    async function selectGrade() {
      active = refreshActive() || (opts.selectRange?.el?.isConnected ? opts.selectRange : null) || active;
      if (!active?.el) return false;
      // Guard: locked tail resize must not click the primary (start≈0) bar.
      if (lockTail) {
        const framed = withGradeFrames(
          active.el ? describeRange(active.el) || active : active,
          getTotalFrames()
        );
        if (framed && framed.startFrame <= 1 && matchStart > 2) {
          return false;
        }
      }
      try {
        active.el.click();
      } catch {
        return false;
      }
      await sleep(200);
      return true;
    }

    async function writeInputs(start, end) {
      let bounds = findRangeBoundInputs();
      if (!bounds) {
        await selectGrade();
        bounds = findRangeBoundInputs();
      }
      if (!bounds) return { ok: false, error: "no-range-inputs" };
      await setInputFrame(bounds.start, start);
      await sleep(80);
      bounds = findRangeBoundInputs() || bounds;
      await setInputFrame(bounds.end, end);
      await sleep(80);
      bounds = findRangeBoundInputs() || bounds;
      await setInputFrame(bounds.start, start);
      await sleep(80);
      bounds = findRangeBoundInputs() || bounds;
      await setInputFrame(bounds.end, end);
      await sleep(120);
      const startEl = document.querySelector('input[aria-label="Range start"]');
      const endEl = document.querySelector('input[aria-label="Range end"]');
      return {
        ok: true,
        startVal: Number(String(startEl?.value || "").replace(/[^\d]/g, "")),
        endVal: Number(String(endEl?.value || "").replace(/[^\d]/g, "")),
      };
    }

    async function fillAt(frame) {
      const jumped = await goToFrame(frame);
      await sleep(70);
      const selected = await selectGrade();
      if (!selected) {
        return { jumped: jumped.ok, via: null, geo: null, error: "fill-no-select" };
      }
      const via = jumped.ok ? clickFillToPlayhead() : null;
      await sleep(240);
      active = refreshActive() || active;
      return { jumped: jumped.ok, via, geo: timelineBounds(active) };
    }

    if (!(await selectGrade()) && !findRangeBoundInputs()) {
      return { ok: false, error: lockTail ? "no-tail-grade" : "no-grade" };
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await selectGrade();
      active = refreshActive() || active;
      let geo = timelineBounds(active);

      // 1) Expand pin → real range via Fill (inputs alone do not grow a pin)
      if (!geo || geo.span <= 2 || Math.abs(geo.startFrame - wantStart) > BOUND_EPS) {
        await fillAt(wantStart);
        active = refreshActive() || active;
        geo = timelineBounds(active);
      }
      if (!geo || geo.endFrame < wantEnd) {
        await fillAt(wantEnd);
        active = refreshActive() || active;
        geo = timelineBounds(active);
      }
      if (geo && geo.span <= 2) {
        await fillAt(wantStart);
        await fillAt(wantEnd);
        active = refreshActive() || active;
        geo = timelineBounds(active);
      }

      // 2) Exact values via Range inputs (works once a real span exists)
      const written = await writeInputs(wantStart, wantEnd);
      await sleep(150);
      active = refreshActive() || active;
      geo = timelineBounds(active);

      // 3) Nudge with Adjust left/right (⌥←/→, ⌥⇧←/→) if still off
      if (geo && !timelineMatches(wantStart, wantEnd, active)) {
        await selectGrade();
        const startDelta = wantStart - geo.startFrame;
        const endDelta = wantEnd - geo.endFrame;
        if (Math.abs(startDelta) > 0 && Math.abs(startDelta) <= 40) {
          adjustLeftSide(startDelta);
          await sleep(120);
        }
        if (Math.abs(endDelta) > 0 && Math.abs(endDelta) <= 40) {
          adjustRightSide(endDelta);
          await sleep(120);
        }
        active = refreshActive() || active;
        geo = timelineBounds(active);
        if (!timelineMatches(wantStart, wantEnd, active)) {
          await writeInputs(wantStart, wantEnd);
          await sleep(120);
        }
      }

      // 4) Last resort: shrink end with Adjust
      active = refreshActive() || active;
      geo = timelineBounds(active);
      if (geo && geo.endFrame > wantEnd && geo.endFrame - wantEnd <= 60) {
        await selectGrade();
        adjustRightSide(wantEnd - geo.endFrame);
        await sleep(150);
        await writeInputs(wantStart, wantEnd);
        await sleep(100);
      }

      // 5) Encord often settles one frame short of Range end — extend if short by 1–2
      active = refreshActive() || active;
      geo = timelineBounds(active);
      if (geo && geo.endFrame < wantEnd && wantEnd - geo.endFrame <= 2) {
        const shortBy = wantEnd - geo.endFrame;
        await selectGrade();
        for (let n = 0; n < shortBy + 1; n += 1) {
          adjustRightSide(1);
          await sleep(100);
          await writeInputs(wantStart, wantEnd);
          await sleep(120);
          active = refreshActive() || active;
          geo = timelineBounds(active);
          if (geo && Math.abs(geo.endFrame - wantEnd) <= BOUND_EPS) break;
        }
      }

      active = refreshActive() || active;
      if (timelineMatches(wantStart, wantEnd, active)) {
        await blurRangeFrameInputs();
        await sleep(160);
        // Re-read after blur — Encord can snap end back by 1 frame on commit
        active = refreshActive() || active;
        geo = timelineBounds(active);
        if (geo && geo.endFrame < wantEnd && wantEnd - geo.endFrame <= 2) {
          await selectGrade();
          adjustRightSide(wantEnd - geo.endFrame);
          await sleep(120);
          await writeInputs(wantStart, wantEnd);
          await sleep(120);
          await blurRangeFrameInputs();
          await sleep(120);
          active = refreshActive() || active;
        }
        if (timelineMatches(wantStart, wantEnd, active)) {
          return {
            ok: true,
            via: "fill+inputs+adjust+timeline",
            after: timelineBounds(active),
            want: { startFrame: wantStart, endFrame: wantEnd },
            written,
            attempts: attempt + 1,
            framesBlurred: true,
          };
        }
      }
    }

    active = refreshActive() || active;
    const t = timelineBounds(active);
    const inputs = findRangeBoundInputs();
    return {
      ok: false,
      error: "cannot-set-timeline-range",
      message: `Frame fields may show the right numbers, but the timeline annotation did not move to ${wantStart}–${wantEnd}.`,
      timeline: t,
      inputs: inputs
        ? {
            start: inputs.start.value,
            end: inputs.end.value,
          }
        : null,
      want: { startFrame: wantStart, endFrame: wantEnd },
      playhead: getCurrentFrame(),
    };
  }

  /**
   * Ensure a trajectory instance exists so Range start/end can be typed.
   * Create may leave a pin at an arbitrary frame — bounds are always rewritten to 0…end next.
   * Never leave "set to current" as the final bounds.
   */
  async function ensureTrajectoryInstance() {
    if (findRangeBoundInputs()) return { ok: true, via: "panel-open" };

    const existing = findPrimaryGradeRange();
    if (existing) {
      try {
        existing.el.click();
      } catch {
        /* ignore */
      }
      await sleep(220);
      if (findRangeBoundInputs()) return { ok: true, via: "clicked-pin" };
    }

    await clearInstanceSelection();
    // Re-assert preferred tile after deselect — ontology clicks must not land on a wrist cam.
    await focusPreferredGradeTile();
    await sleep(40);
    const activated = activateTrajectoryClass();
    if (!activated) return { ok: false, error: "no-trajectory-class" };
    await sleep(180);

    const gradeHit = [...document.querySelectorAll("label, [role='radio'], button, [role='button']")].find(
      (el) => {
        if (el.closest('[data-testid="range"]')) return false;
        if (el.closest('[data-testid="classification-timeline"]')) return false;
        const t = normalizeLabel(el.textContent);
        return t.length > 0 && t.length < 16 && /^grade$/i.test(t);
      }
    );
    if (gradeHit) gradeHit.click();
    else pressEditorKey("q");
    await sleep(100);

    // Prefer a pin at frame 0 when creating, but Range inputs always overwrite to 0…end.
    // If jump fails, still create a throwaway pin — do NOT use set-start/end-to-current as final.
    const atZero = await goToFrame(0);
    document.activeElement?.blur?.();
    await sleep(40);

    if (atZero.ok) {
      clickControlByText([/this frame\s*&\s*save/i, /^this frame$/i, /this frame/i]);
    } else {
      // Last resort: click empty trajectory row near left edge (frame ~0), not "current"
      const row = findRowByTestId("row-trajectory");
      if (row) {
        const rect = row.getBoundingClientRect();
        const x = rect.left + 4;
        const y = rect.top + rect.height / 2;
        const el = document.elementFromPoint(x, y) || row;
        el.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            altKey: true,
            view: window,
          })
        );
      }
    }
    await sleep(400);

    const pin = findPrimaryGradeRange();
    if (pin) {
      try {
        pin.el.click();
      } catch {
        /* ignore */
      }
      await sleep(220);
    }

    if (findRangeBoundInputs() || findPrimaryGradeRange()) {
      return { ok: true, via: atZero.ok ? "pin-at-zero" : "pin-provisional", created: true };
    }
    return { ok: false, error: "create-pin-failed" };
  }

  /**
   * Always create a new Grade pin at `frame` (for the post-last-step tail).
   * Does not reuse the primary 0…last-step instance.
   */
  async function createGradePinAt(frame) {
    const total = getTotalFrames();
    const at = Math.max(0, Math.min(Math.floor(frame), episodeLastFrame(total) ?? Math.floor(frame)));
    const before = new Set(listGradeRanges().map((r) => r.el));

    await clearInstanceSelection();
    await focusPreferredGradeTile();
    await sleep(40);
    const activated = activateTrajectoryClass();
    if (!activated) return { ok: false, error: "no-trajectory-class" };
    await sleep(180);

    const gradeHit = [...document.querySelectorAll("label, [role='radio'], button, [role='button']")].find(
      (el) => {
        if (el.closest('[data-testid="range"]')) return false;
        if (el.closest('[data-testid="classification-timeline"]')) return false;
        const t = normalizeLabel(el.textContent);
        return t.length > 0 && t.length < 16 && /^grade$/i.test(t);
      }
    );
    if (gradeHit) gradeHit.click();
    else pressEditorKey("q");
    await sleep(100);

    const jumped = await goToFrame(at);
    document.activeElement?.blur?.();
    await sleep(40);

    if (jumped.ok) {
      clickControlByText([/this frame\s*&\s*save/i, /^this frame$/i, /this frame/i]);
    } else if (total) {
      const row = findRowByTestId("row-trajectory");
      if (row) {
        const rect = row.getBoundingClientRect();
        const x = rect.left + Math.max(4, (at / Math.max(1, total - 1)) * rect.width);
        const y = rect.top + rect.height / 2;
        const el = document.elementFromPoint(x, y) || row;
        el.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            altKey: true,
            view: window,
          })
        );
      }
    }
    await sleep(450);

    let pin =
      findGradeNearStart(at, total) ||
      listGradeRanges().find((r) => !before.has(r.el)) ||
      null;
    if (pin?.el) {
      try {
        pin.el.click();
      } catch {
        /* ignore */
      }
      await sleep(220);
      pin = findGradeNearStart(at, total) || pin;
    }

    // G2 = last Grade option in the selection array ("incomplete")
    const gradeValue = await applyIncompleteGradeToRange(pin);
    await sleep(80);

    if (findRangeBoundInputs() || pin) {
      return {
        ok: true,
        via: jumped.ok ? "pin-at-frame" : "pin-provisional",
        created: true,
        frame: at,
        range: pin,
        gradeValue,
      };
    }
    return { ok: false, error: "create-tail-pin-failed", frame: at, gradeValue };
  }

  /**
   * Create a Step pin at `frame` for S2 (post-last-step tail).
   * Success requires a discoverable pin element (geometry) — Range inputs alone
   * are not enough (they may belong to another selection).
   */
  async function createStepPinAt(frame) {
    const total = getTotalFrames();
    const at = Math.max(0, Math.min(Math.floor(frame), episodeLastFrame(total) ?? Math.floor(frame)));
    const before = new Set(listAllStepRanges(total).map((r) => r.el));

    await clearInstanceSelection();
    await focusPreferredGradeTile();
    await sleep(40);
    const activated = activateStepClass();
    if (!activated) return { ok: false, error: "no-step-class" };
    await sleep(180);

    let selected = selectIncompleteStepOption();
    await sleep(100);

    const jumped = await goToFrame(at);
    document.activeElement?.blur?.();
    await sleep(40);

    if (jumped.ok) {
      clickControlByText([/this frame\s*&\s*save/i, /^this frame$/i, /this frame/i]);
    } else if (total) {
      const row = findRowByTestId("row-step");
      if (row) {
        const rect = row.getBoundingClientRect();
        const x = rect.left + Math.max(4, (at / Math.max(1, total - 1)) * rect.width);
        const y = rect.top + rect.height / 2;
        const el = document.elementFromPoint(x, y) || row;
        el.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            altKey: true,
            view: window,
          })
        );
      }
    }
    await sleep(450);

    let pin =
      findStepTailByGeometry(at, total) ||
      listAllStepRanges(total).find((r) => !before.has(r.el)) ||
      null;
    if (pin?.el) {
      try {
        pin.el.click();
      } catch {
        /* ignore */
      }
      await sleep(220);
      pin = findStepTailByGeometry(at, total) || pin;
      selected = selectIncompleteStepOption() || selected;
      await sleep(80);
    }

    if (!pin?.el) {
      return { ok: false, error: "create-step-tail-pin-failed", frame: at, selected };
    }
    return {
      ok: true,
      via: jumped.ok ? "pin-at-frame" : "pin-provisional",
      created: true,
      frame: at,
      range: pin,
      selected,
    };
  }

  /** Expand Step pin → [start,end] like G2 (select + Fill + Range inputs). */
  async function expandStepPinToRange(pin, start, end) {
    const total = getTotalFrames();
    if (!pin?.el) return { ok: false, error: "no-step-pin" };

    try {
      pin.el.click();
    } catch {
      /* ignore */
    }
    await sleep(180);
    await goToFrame(end);
    await sleep(80);
    clickFillToPlayhead();
    await sleep(280);

    let wrote = await resizeViaRangeInputs(start, end, {
      matchStart: start,
      selectRange: pin,
      lockToSelectRange: true,
    });
    await sleep(100);

    let step = findStepTailByGeometry(start, total) || pin;
    const spanOk =
      step &&
      Math.abs(step.startFrame - start) <= BOUND_EPS &&
      Math.abs(step.endFrame - end) <= BOUND_EPS &&
      (step.span ?? step.endFrame - step.startFrame) > 2;

    if (wrote.ok && spanOk) {
      return { ok: true, via: wrote.via || "range-inputs", step };
    }

    // Second pass: re-select + fill + set both bounds
    step = findStepTailByGeometry(start, total) || step;
    if (step?.el) {
      try {
        step.el.click();
      } catch {
        /* ignore */
      }
      await sleep(150);
    }
    await goToFrame(end);
    await sleep(60);
    clickFillToPlayhead();
    await sleep(220);
    const bounds = findRangeBoundInputs();
    if (bounds) {
      await setInputFrame(bounds.start, start);
      await sleep(80);
      await setInputFrame(bounds.end, end);
      await sleep(140);
    }
    wrote = await resizeViaRangeInputs(start, end, {
      matchStart: start,
      selectRange: step || pin,
      lockToSelectRange: true,
    });
    await sleep(100);
    step = findStepTailByGeometry(start, total) || step;
    const ok =
      step &&
      Math.abs(step.startFrame - start) <= BOUND_EPS &&
      Math.abs(step.endFrame - end) <= BOUND_EPS &&
      (step.span ?? 0) > 2;
    return {
      ok: !!ok,
      via: wrote.via || (bounds ? "fill+inputs" : "unknown"),
      step,
      wrote,
    };
  }

  /**
   * After G2 is complete: S2 = incomplete Step from lastStepEnd+1 → episode end.
   * Finds pins by geometry (empty labels). Expands before setting incomplete. Esc.
   */
  async function ensureIncompleteStepTail({ tailStart, episodeEnd }) {
    const total = getTotalFrames();
    if (episodeEnd == null || tailStart == null || tailStart > episodeEnd) {
      return { ok: true, skipped: true, reason: "no-step-tail-frames" };
    }

    function findTailStep() {
      return findStepTailByGeometry(tailStart, total);
    }

    function isReady(s) {
      return (
        s &&
        (s.span ?? s.endFrame - s.startFrame) > 2 &&
        Math.abs(s.startFrame - tailStart) <= BOUND_EPS &&
        Math.abs(s.endFrame - episodeEnd) <= BOUND_EPS
      );
    }

    let step = findTailStep();
    if (isReady(step) && (step.incomplete || isIncompleteStepLabel(step.label))) {
      pressEditorKey("Escape");
      await sleep(80);
      return { ok: true, skipped: true, reason: "step-tail-already-synced", step, label: "incomplete" };
    }

    // Create pin at tailStart if missing / wrong start
    if (!step || Math.abs((step.startFrame ?? -1) - tailStart) > 2) {
      const created = await createStepPinAt(tailStart);
      if (!created.ok) {
        return { ok: false, error: created.error || "create-step-tail-failed", created };
      }
      step = findTailStep() || created.range;
      if (!step?.el) {
        return { ok: false, error: "no-step-tail-instance", created };
      }
    }

    // Expand pin → episode end (geometry-backed; do not trust Range inputs alone)
    let wrote = { ok: false };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      step = findTailStep() || step;
      wrote = await expandStepPinToRange(step, tailStart, episodeEnd);
      await sleep(120);
      step = findTailStep() || wrote.step || step;
      if (isReady(step)) break;
    }

    step = findTailStep() || step;
    if (!isReady(step)) {
      return {
        ok: false,
        error: "step-tail-expand-failed",
        step,
        wrote,
        expected: { start: tailStart, end: episodeEnd },
      };
    }

    // Incomplete only after a real span exists
    const stepValue = await applyIncompleteStepToRange(step);
    await sleep(80);

    await blurRangeFrameInputs();
    pressEditorKey("Escape");
    await sleep(100);

    step = findTailStep() || step;
    const ok =
      isReady(step) &&
      (step.incomplete || isIncompleteStepLabel(step.label) || stepValue?.ok);
    return {
      ok,
      via: wrote.via || "expand+incomplete+esc",
      label: "incomplete",
      startFrame: tailStart,
      endFrame: episodeEnd,
      wrote,
      stepValue,
      step,
      error: ok ? undefined : "step-tail-incomplete-or-bounds",
    };
  }

  function snapshot() {
    const totalFrames = getTotalFrames();
    const defined = definedStepsCache?.projectKey === getProjectKey() ? definedStepsCache : null;
    const lastDefinedNum = defined?.lastStepNum ?? null;
    const lastStep = lastDefinedNum != null ? findStepRangeByNum(lastDefinedNum) : findLastTimelineStepRange();
    const timelineMax = findLastTimelineStepRange();
    const grade = findPrimaryGradeRange();
    if (!totalFrames) {
      return {
        ready: false,
        reason: "no-frames",
        totalFrames,
        lastStep: null,
        grade: null,
        definedSteps: defined,
      };
    }
    if (!lastStep) {
      return {
        ready: false,
        reason:
          lastDefinedNum != null
            ? "last-defined-step-not-on-timeline"
            : "no-last-step",
        totalFrames,
        lastStep: null,
        grade: null,
        definedSteps: defined,
        timelineMaxStep: timelineMax
          ? { stepNum: timelineMax.stepNum, endFrame: pctToEndFrame(timelineMax.end, totalFrames) }
          : null,
      };
    }
    const targetEndPct = lastStep.end;
    const targetEndFrame = pctToEndFrame(targetEndPct, totalFrames);
    const episodeEnd = episodeLastFrame(totalFrames);
    const tailStart = targetEndFrame + 1;
    const hasTail = episodeEnd != null && tailStart <= episodeEnd;
    const gradeEndFrame = grade ? pctToEndFrame(grade.end, totalFrames) : null;
    const gradeStartFrame = grade ? pctToFrame(grade.left, totalFrames) : null;
    const gradeSpan =
      grade && gradeEndFrame != null && gradeStartFrame != null ? gradeEndFrame - gradeStartFrame : 0;
    const primaryNeedsSync =
      !grade ||
      gradeSpan <= 2 ||
      Math.abs((gradeStartFrame ?? -1) - 0) > BOUND_EPS ||
      Math.abs((gradeEndFrame ?? -1) - targetEndFrame) > BOUND_EPS;

    const tailGrade = hasTail ? findGradeNearStart(tailStart, totalFrames) : null;
    const stepTail = hasTail
      ? findStepNearStart(tailStart, { incomplete: true, totalFrames }) ||
        findStepNearStart(tailStart, { totalFrames })
      : null;
    const tailOk =
      !hasTail ||
      (tailGrade &&
        (tailGrade.span ?? tailGrade.endFrame - tailGrade.startFrame) > 2 &&
        Math.abs(tailGrade.startFrame - tailStart) <= BOUND_EPS &&
        Math.abs(tailGrade.endFrame - episodeEnd) <= BOUND_EPS);
    const stepTailOk =
      !hasTail ||
      (stepTail &&
        (stepTail.span ?? stepTail.endFrame - stepTail.startFrame) > 2 &&
        Math.abs(stepTail.startFrame - tailStart) <= BOUND_EPS &&
        Math.abs(stepTail.endFrame - episodeEnd) <= BOUND_EPS);
    const needsSync = primaryNeedsSync || !tailOk || !stepTailOk;

    return {
      ready: true,
      totalFrames,
      lastStep: {
        stepNum: lastStep.stepNum,
        label: lastStep.label.slice(0, 80),
        left: lastStep.left,
        end: lastStep.end,
        endFrame: targetEndFrame,
      },
      grade: grade
        ? {
            left: grade.left,
            end: grade.end,
            startFrame: gradeStartFrame,
            endFrame: gradeEndFrame,
            span: gradeSpan,
          }
        : null,
      tailGrade: tailGrade
        ? {
            startFrame: tailGrade.startFrame,
            endFrame: tailGrade.endFrame,
            span: tailGrade.span,
          }
        : null,
      stepTail: stepTail
        ? {
            stepNum: stepTail.stepNum,
            incomplete: !!stepTail.incomplete,
            label: (stepTail.label || "").slice(0, 40),
            startFrame: stepTail.startFrame,
            endFrame: stepTail.endFrame,
            span: stepTail.span,
          }
        : null,
      target: { startFrame: 0, endFrame: targetEndFrame, startPct: 0, endPct: targetEndPct },
      tailTarget: hasTail ? { startFrame: tailStart, endFrame: episodeEnd } : null,
      stepTailTarget: hasTail
        ? { label: "incomplete", startFrame: tailStart, endFrame: episodeEnd }
        : null,
      needsSync,
      gradeCount: listGradeRanges().length,
      definedSteps: defined,
      timelineMaxStep: timelineMax
        ? { stepNum: timelineMax.stepNum, endFrame: pctToEndFrame(timelineMax.end, totalFrames) }
        : null,
      key: `step${lastStep.stepNum}:${targetEndFrame}:${totalFrames}:tail${hasTail ? `${tailStart}-${episodeEnd}` : "none"}:s2=incomplete`,
    };
  }

  async function waitForPageFocus(timeoutMs = 2500) {
    if (document.hasFocus()) return { ok: true, waited: false };
    const started = Date.now();
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.removeEventListener("focus", onFocus);
        document.removeEventListener("visibilitychange", onVis);
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      };
      const onFocus = () => finish();
      const onVis = () => {
        if (document.visibilityState === "visible" && document.hasFocus()) finish();
      };
      window.addEventListener("focus", onFocus);
      document.addEventListener("visibilitychange", onVis);
      const poll = setInterval(() => {
        if (document.hasFocus()) finish();
      }, 50);
      const timer = setTimeout(finish, timeoutMs);
    });
    return { ok: document.hasFocus(), waited: true, ms: Date.now() - started };
  }

  async function syncGrade({ force = false, quiet = false } = {}) {
    if (!enabled && !force) return { ok: false, skipped: true, reason: "disabled" };
    if (syncing) return { ok: false, skipped: true, reason: "busy" };
    if (!location.pathname.includes("/label_editor/")) {
      return { ok: false, skipped: true, reason: "not-editor" };
    }

    // Auto path: require ontology last Step id, and that it exists on the timeline.
    if (!force) {
      const defined = await ensureDefinedLastStep();
      if (!defined?.lastStepNum) {
        return { ok: false, skipped: true, reason: "no-defined-steps" };
      }
      const onTimeline = findStepRangeByNum(defined.lastStepNum);
      if (!onTimeline) {
        return {
          ok: false,
          skipped: true,
          reason: "waiting-for-last-defined-step",
          wantStep: defined.lastStepNum,
          timelineMax: findLastTimelineStepRange()?.stepNum ?? null,
        };
      }
    } else {
      // Manual sync: refresh defined steps so target prefers ontology last if present
      await ensureDefinedLastStep();
    }

    const snap = snapshot();
    if (!snap.ready) return { ok: false, skipped: true, reason: snap.reason, snap };
    if (!snap.needsSync && !force) {
      return { ok: true, skipped: true, reason: "already-synced", snap };
    }

    syncing = true;
    try {
      // Details panel steals focus — wait until the editor is focused before creating Grade.
      await waitForPageFocus(force ? 2500 : 800);

      // Absolute bounds only — never derive start from playhead / currentFrame
      const endFrame = snap.target.endFrame;

      const ensured = await ensureTrajectoryInstance();
      if (!ensured.ok) {
        if (!quiet) {
          const msg = "Could not open/create trajectory for Grade sync.";
          if (lastToastKey !== msg) {
            lastToastKey = msg;
            showToast(msg, "warn");
          }
        }
        return { ok: false, error: ensured.error || "ensure-failed", ensured, snap };
      }

      const wrote = await resizeViaRangeInputs(0, endFrame, { matchStart: 0 });
      if (wrote.ok) {
        // Final guard: start must be 0 and end must be last-step (not playhead)
        const check = snapshot();
        const playhead = getCurrentFrame();
        const endOk =
          check.grade &&
          Math.abs((check.grade.endFrame ?? -1) - endFrame) <= BOUND_EPS;
        const startOk = check.grade && Math.abs((check.grade.startFrame ?? -1) - 0) <= BOUND_EPS;
        const endIsPlayhead =
          playhead != null &&
          check.grade &&
          Math.abs((check.grade.endFrame ?? -1) - playhead) <= BOUND_EPS &&
          Math.abs(endFrame - playhead) > BOUND_EPS;

        if (!startOk || !endOk || endIsPlayhead) {
          const retry = await resizeViaRangeInputs(0, endFrame, { matchStart: 0 });
          const afterRetry = snapshot();
          const retryOk =
            retry.ok &&
            afterRetry.grade &&
            Math.abs((afterRetry.grade.startFrame ?? -1) - 0) <= BOUND_EPS &&
            Math.abs((afterRetry.grade.endFrame ?? -1) - endFrame) <= BOUND_EPS;
          if (!retryOk) {
            return {
              ok: false,
              error: endIsPlayhead ? "end-is-playhead" : "bounds-mismatch",
              wrote,
              retry,
              snap: afterRetry,
              playhead,
              wantEnd: endFrame,
            };
          }
        }

        // Second Grade: abut primary end + 1 → episode end.
        // Creating/resizing G2 used to fall back onto G1 (Fill + Range inputs), which
        // shrunk G1 by 1 and left G2 starting one frame late. Pin G2 away from the
        // G1 boundary, lock resize to that instance, then re-assert G1.
        const total = snap.totalFrames || getTotalFrames();
        const episodeEnd = episodeLastFrame(total);
        let primaryGeo = findPrimaryGradeRange();
        let primaryEnd = primaryGeo?.endFrame ?? endFrame;
        if (primaryEnd < endFrame && endFrame - primaryEnd <= 2) {
          const fixShort = await resizeViaRangeInputs(0, endFrame, { matchStart: 0 });
          primaryGeo = findPrimaryGradeRange();
          primaryEnd = primaryGeo?.endFrame ?? primaryEnd;
          if (!fixShort.ok || primaryEnd < endFrame) {
            return {
              ok: false,
              error: "primary-end-short",
              wrote,
              fixShort,
              wantEnd: endFrame,
              primaryEnd,
              snap: snapshot(),
            };
          }
        }
        const tailStart = endFrame + 1;
        let wroteTail = { ok: true, skipped: true, reason: "no-tail-frames" };
        let wroteStepTail = { ok: true, skipped: true, reason: "no-tail-frames" };
        if (episodeEnd != null && tailStart <= episodeEnd) {
          let tail = findGradeNearStart(tailStart, total);
          // Prefer an existing non-primary grade in the tail region; avoid the primary.
          if (tail && tail.startFrame <= 1) tail = null;
          const tailReady =
            tail &&
            (tail.span ?? 0) > 2 &&
            Math.abs(tail.startFrame - tailStart) <= BOUND_EPS &&
            Math.abs(tail.endFrame - episodeEnd) <= BOUND_EPS;
          if (!tailReady) {
            if (!tail || Math.abs((tail.startFrame ?? -1) - tailStart) > 2) {
              // Create far from G1's end so Encord doesn't auto-trim the abutting edge.
              const pinAt = episodeEnd;
              const createdTail = await createGradePinAt(pinAt);
              if (!createdTail.ok) {
                wroteTail = { ok: false, error: createdTail.error || "create-tail-failed", createdTail };
              } else {
                tail =
                  findGradeNearStart(pinAt, total) ||
                  findGradeNearStart(tailStart, total) ||
                  createdTail.range;
                if (tail && tail.startFrame <= 1) {
                  wroteTail = { ok: false, error: "tail-pin-resolved-to-primary" };
                  tail = null;
                }
              }
            }
            if (wroteTail.ok !== false && tail) {
              wroteTail = await resizeViaRangeInputs(tailStart, episodeEnd, {
                matchStart: Math.max(tailStart, tail.startFrame || tailStart),
                selectRange: tail,
                lockToSelectRange: true,
              });
            } else if (wroteTail.ok !== false && !tail) {
              wroteTail = { ok: false, error: "no-tail-instance" };
            }
          } else {
            wroteTail = { ok: true, skipped: true, reason: "tail-already-synced" };
          }

          // Re-assert G1 after G2 — Encord / mistaken Fill can still trim primary by 1.
          await sleep(120);
          primaryGeo = findPrimaryGradeRange();
          if (
            !primaryGeo ||
            Math.abs((primaryGeo.endFrame ?? -1) - endFrame) > BOUND_EPS ||
            Math.abs((primaryGeo.startFrame ?? -1) - 0) > BOUND_EPS
          ) {
            const restorePrimary = await resizeViaRangeInputs(0, endFrame, { matchStart: 0 });
            primaryGeo = findPrimaryGradeRange();
            if (
              !restorePrimary.ok ||
              Math.abs((primaryGeo?.endFrame ?? -1) - endFrame) > BOUND_EPS
            ) {
              return {
                ok: false,
                error: "primary-trimmed-by-tail",
                wrote,
                wroteTail,
                restorePrimary,
                wantEnd: endFrame,
                primaryEnd: primaryGeo?.endFrame,
                snap: snapshot(),
              };
            }
          }

          // G1 restore / blur often leaves G2 short of episode end — always re-check.
          // Episode last frame == totalFrames; verify CSS and Range end input.
          await sleep(100);
          let tailAfter = findGradeNearStart(tailStart, total);
          if (tailAfter && tailAfter.startFrame > 1) {
            const startOk = Math.abs(tailAfter.startFrame - tailStart) <= BOUND_EPS;
            let endOk = Math.abs((tailAfter.endFrame ?? -1) - episodeEnd) <= BOUND_EPS;
            if (!endOk) {
              try {
                tailAfter.el.click();
                await sleep(150);
                const b = findRangeBoundInputs();
                const endVal = b
                  ? Number(String(b.end.value || "").replace(/[^\d]/g, ""))
                  : null;
                if (endVal != null && Math.abs(endVal - episodeEnd) <= BOUND_EPS) {
                  endOk = true;
                }
              } catch {
                /* ignore */
              }
            }
            if (!startOk) {
              wroteTail = await resizeViaRangeInputs(tailStart, episodeEnd, {
                matchStart: tailStart,
                selectRange: tailAfter,
                lockToSelectRange: true,
              });
              tailAfter = findGradeNearStart(tailStart, total) || tailAfter;
            } else if (!endOk) {
              const extended = await extendGradeEndOnly(tailAfter, episodeEnd, {
                matchStart: tailStart,
              });
              wroteTail = extended.ok
                ? { ok: true, via: "extend-end-only", extended }
                : { ok: false, error: extended.error || "tail-end-short", extended };
              tailAfter = findGradeNearStart(tailStart, total) || tailAfter;
            }
            // Final end check even after full resize
            if (wroteTail.ok !== false && tailAfter) {
              let stillShort =
                Math.abs((tailAfter.endFrame ?? -1) - episodeEnd) > BOUND_EPS;
              if (stillShort) {
                try {
                  tailAfter.el.click();
                  await sleep(120);
                  const b = findRangeBoundInputs();
                  const endVal = b
                    ? Number(String(b.end.value || "").replace(/[^\d]/g, ""))
                    : null;
                  if (endVal != null && Math.abs(endVal - episodeEnd) <= BOUND_EPS) {
                    stillShort = false;
                  }
                } catch {
                  /* ignore */
                }
              }
              if (stillShort) {
                const extended = await extendGradeEndOnly(tailAfter, episodeEnd, {
                  matchStart: tailStart,
                });
                if (!extended.ok) {
                  wroteTail = {
                    ok: false,
                    error: "tail-end-short",
                    extended,
                    endFrame: tailAfter.endFrame,
                    wantEnd: episodeEnd,
                  };
                } else {
                  wroteTail = { ok: true, via: "extend-end-only-final", extended };
                }
              }
            }
          }
          // G2 value = last Grade option in the selection array ("incomplete")
          const tailForValue =
            findGradeNearStart(tailStart, total) || tailAfter || tail;
          let gradeValue = null;
          if (wroteTail.ok !== false && tailForValue?.el) {
            gradeValue = await applyIncompleteGradeToRange(tailForValue);
            wroteTail = { ...wroteTail, gradeValue };
            await sleep(60);
          }
          primaryEnd = findPrimaryGradeRange()?.endFrame ?? endFrame;

          // S2 ONLY after G2 is fully in place: incomplete Step (last option)
          // from lastStepEnd+1 → episode end, then Esc.
          if (wroteTail.ok !== false) {
            wroteStepTail = await ensureIncompleteStepTail({
              tailStart,
              episodeEnd,
            });
          } else {
            wroteStepTail = { ok: true, skipped: true, reason: "grade-tail-failed" };
          }
        }

        const after = snapshot();
        lastAppliedKey = snap.key;
        await blurRangeFrameInputs();
        pressEditorKey("Escape");
        await sleep(60);
        if (!quiet) {
          const tailBit =
            wroteTail.skipped && wroteTail.reason === "no-tail-frames"
              ? ""
              : wroteTail.ok
                ? ` + G2 ${tailStart}–${episodeEnd}`
                : ` (G2 ${tailStart}–${episodeEnd} failed)`;
          const stepTailBit =
            wroteStepTail.skipped &&
            (wroteStepTail.reason === "no-tail-frames" ||
              wroteStepTail.reason === "grade-tail-failed")
              ? ""
              : wroteStepTail.ok
                ? ` + S2 incomplete ${tailStart}–${episodeEnd}`
                : ` (S2 failed)`;
          const msg = ensured.created
            ? `Grade 0–${primaryEnd}${tailBit}${stepTailBit}`
            : `Grade set 0–${primaryEnd}${tailBit}${stepTailBit}`;
          if (lastToastKey !== msg) {
            lastToastKey = msg;
            showToast(
              msg,
              wroteTail.ok === false || wroteStepTail.ok === false ? "warn" : "ok"
            );
          }
        }
        return {
          ok: wroteTail.ok !== false && wroteStepTail.ok !== false,
          method: "ensure+range-inputs+tail+step-tail",
          snap: after,
          ensured,
          wrote,
          wroteTail,
          wroteStepTail,
          primaryEnd,
          error:
            wroteTail.ok === false
              ? wroteTail.error
              : wroteStepTail.ok === false
                ? wroteStepTail.error
                : undefined,
        };
      }

      if (!quiet) {
        const msg =
          wrote.error === "cannot-set-timeline-range"
            ? `Could not commit Grade on the timeline (${wrote.timeline?.startFrame ?? "?"}–${wrote.timeline?.endFrame ?? "?"} vs 0–${endFrame}).`
            : `Could not set Range start/end (${wrote.error || "failed"}).`;
        if (lastToastKey !== msg) {
          lastToastKey = msg;
          showToast(msg, "warn");
        }
      }
      return { ok: false, error: wrote.error || "range-inputs-failed", ensured, wrote, snap };
    } catch (err) {
      return { ok: false, error: err?.message || String(err), snap };
    } finally {
      syncing = false;
    }
  }

  /** After Step edit → Escape/Done, fit Grade only if ontology last Step is on the timeline. */
  function scheduleWorkflowSync() {
    if (!enabled || syncing) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      (async () => {
        const defined = await ensureDefinedLastStep();
        if (!defined?.lastStepNum) return;
        if (!findStepRangeByNum(defined.lastStepNum)) return;
        await syncGrade({ quiet: false });
      })().catch(() => {});
    }, WORKFLOW_DEBOUNCE_MS);
  }

  /**
   * When the last defined Step's end moves on the timeline (e.g. drag ±1 frame),
   * re-fit Grade to match — without waiting for Escape/Done.
   */
  function scheduleLastStepResizeSync() {
    if (!enabled || syncing) return;
    clearTimeout(lastStepResizeTimer);
    lastStepResizeTimer = setTimeout(() => {
      (async () => {
        const defined = await ensureDefinedLastStep();
        if (!defined?.lastStepNum) return;
        const lastRange = findStepRangeByNum(defined.lastStepNum);
        if (!lastRange) return;

        const total = getTotalFrames();
        if (!total) return;
        const endFrame = pctToEndFrame(lastRange.end, total);
        const endKey = `step${defined.lastStepNum}:${endFrame}:${total}`;

        // Still settling / unchanged
        if (endKey === lastObservedStepEndKey && endKey === lastAppliedKey) return;

        const grade = findPrimaryGradeRange();
        // Only auto-refit when Grade already exists (creation stays Escape/Done gated)
        if (!grade) {
          lastObservedStepEndKey = endKey;
          return;
        }

        const gradeEnd = pctToEndFrame(grade.end, total);
        const gradeStart = pctToFrame(grade.left, total);
        const already =
          Math.abs(gradeStart - 0) <= BOUND_EPS &&
          Math.abs(gradeEnd - endFrame) <= BOUND_EPS;
        lastObservedStepEndKey = endKey;
        if (already) return;

        await syncGrade({ quiet: true });
      })().catch(() => {});
    }, LAST_STEP_RESIZE_DEBOUNCE_MS);
  }

  function ensureStepRowObserver() {
    if (stepRowObserver) return;
    const attach = () => {
      const row = findRowByTestId("row-step");
      if (!row || row.dataset.encordGradeStepWatch === "1") return !!row;
      row.dataset.encordGradeStepWatch = "1";
      stepRowObserver = new MutationObserver(() => {
        scheduleLastStepResizeSync();
      });
      stepRowObserver.observe(row, {
        attributes: true,
        subtree: true,
        attributeFilter: ["style", "class"],
        childList: true,
      });
      return true;
    };
    if (attach()) return;
    // Timeline may mount later
    const boot = new MutationObserver(() => {
      if (attach()) boot.disconnect();
    });
    boot.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => boot.disconnect(), 60000);
  }

  async function loadEnabled() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_ENABLED);
      if (typeof stored[STORAGE_ENABLED] === "boolean") enabled = stored[STORAGE_ENABLED];
      else enabled = true; // on by default — Escape/Done after last *defined* Step
    } catch {
      enabled = true;
    }
  }

  function startWatch() {
    // Discover Classes → Step list once the editor is up (non-blocking)
    setTimeout(() => {
      if (location.pathname.includes("/label_editor/")) {
        discoverDefinedSteps({ force: false }).catch(() => {});
        ensureStepRowObserver();
      }
    }, 1200);

    // Trusted Escape = Done on instance panel (your step workflow)
    document.addEventListener(
      "keyup",
      (event) => {
        if (!event.isTrusted) return;
        if (event.key !== "Escape") return;
        if (!location.pathname.includes("/label_editor/")) return;
        scheduleWorkflowSync();
      },
      true
    );

    // Done button click (same as Escape on the panel)
    document.addEventListener(
      "click",
      (event) => {
        if (!event.isTrusted) return;
        if (!location.pathname.includes("/label_editor/")) return;
        const btn = event.target?.closest?.("button, [role='button']");
        if (!btn) return;
        const t = normalizeLabel(btn.textContent || "");
        if (!/^done\b/i.test(t) && !/^done\s*esc$/i.test(t)) return;
        scheduleWorkflowSync();
      },
      true
    );

    // Dragging step handles / releasing after ±1 frame adjust
    document.addEventListener(
      "pointerup",
      (event) => {
        if (!event.isTrusted) return;
        if (!location.pathname.includes("/label_editor/")) return;
        if (
          !event.target?.closest?.('[data-testid="classification-timeline"]') &&
          !findRowByTestId("row-step")?.contains(event.target)
        ) {
          return;
        }
        scheduleLastStepResizeSync();
      },
      true
    );

    // Editing last Step via Range end input then blur/Enter
    document.addEventListener(
      "change",
      (event) => {
        if (!event.isTrusted) return;
        const input = event.target;
        if (!(input instanceof HTMLInputElement)) return;
        const aria = input.getAttribute("aria-label") || "";
        if (aria !== "Range end" && aria !== "Range start") return;
        const instance = normalizeLabel(
          document.querySelector('[data-testid="instance-name"]')?.textContent || ""
        ).toLowerCase();
        if (instance !== "step") return;
        scheduleLastStepResizeSync();
      },
      true
    );

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[STORAGE_ENABLED]) return;
      enabled = changes[STORAGE_ENABLED].newValue !== false;
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GRADE_SYNC_NOW") {
      syncGrade({ force: true, quiet: false })
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
      return true;
    }
    if (message?.type === "GRADE_SYNC_STATUS") {
      loadEnabled().then(async () => {
        await ensureDefinedLastStep();
        sendResponse({
          ok: true,
          version: VERSION,
          enabled,
          snapshot: snapshot(),
          definedSteps: definedStepsCache,
          lastAppliedKey,
        });
      });
      return true;
    }
    if (message?.type === "GRADE_SYNC_SET_ENABLED") {
      enabled = message.enabled !== false;
      chrome.storage.local.set({ [STORAGE_ENABLED]: enabled }).then(() => {
        sendResponse({ ok: true, enabled });
        if (enabled) scheduleWorkflowSync();
      });
      return true;
    }
    if (message?.type === "GRADE_DISCOVER_STEPS") {
      discoverDefinedSteps({ force: true })
        .then((defined) => sendResponse({ ok: !!defined, defined }))
        .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
      return true;
    }
    return false;
  });

  window.__encordGradeSync = {
    version: VERSION,
    snapshot,
    syncGrade,
    discoverDefinedSteps,
    ensureDefinedLastStep,
  };

  loadEnabled().then(startWatch);
})();
