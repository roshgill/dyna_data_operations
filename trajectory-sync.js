// Auto-sync Trajectory → Grade to 0 → end of last Step.
// Write path: Encord classification UI (frame jump + C/V/M or Range start/end inputs).
// No timeline draw-drag / alt-click / shift-click (those create single-frame pins).
(() => {
  const VERSION = "0.18.64-grade";
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
  /** UI settle waits — keep low; success paths early-exit / poll. */
  const W = {
    tick: 20,
    short: 40,
    med: 60,
    panel: 80,
    settle: 80,
    create: 280,
  };

  if (window.__encordGradeSync?.version === VERSION) return;

  let enabled = true;
  let syncing = false;
  let debounceTimer = null;
  let lastStepResizeTimer = null;
  let lastToastKey = "";
  let lastAppliedKey = "";
  let lastObservedStepEndKey = "";
  /** Auto annotation runs once per episode; further last-Step edits do not re-trigger. */
  let autoAnnotatedOnce = false;
  let autoAnnotatedEpisodeKey = "";
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

  function nowMs() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }

  function msSince(t0) {
    return Math.max(0, Math.round(nowMs() - t0));
  }

  async function waitUntil(pred, { timeout = 400, interval = 20 } = {}) {
    const t0 = nowMs();
    for (;;) {
      try {
        if (pred()) return true;
      } catch {
        /* ignore */
      }
      if (msSince(t0) >= timeout) {
        try {
          return !!pred();
        } catch {
          return false;
        }
      }
      await sleep(interval);
    }
  }

  /** Compact phase timings for toast / console (ms → one decimal seconds). */
  function formatTimingSecs(ms) {
    if (ms == null || !Number.isFinite(ms)) return "?";
    return (ms / 1000).toFixed(1);
  }

  function logSyncTiming(timing, ok) {
    try {
      console.info("[encord-grade-sync] timing", { ok, ...timing });
    } catch {
      /* ignore */
    }
  }

  let toastHideTimer = null;
  let progressDotsTimer = null;

  function ensureToastHost() {
    let el = document.getElementById("encord-camera-layout-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "encord-camera-layout-toast";
      document.documentElement.appendChild(el);
    }
    return el;
  }

  function clearToastHide() {
    if (toastHideTimer != null) {
      clearTimeout(toastHideTimer);
      toastHideTimer = null;
    }
  }

  function clearProgressDots() {
    if (progressDotsTimer != null) {
      clearInterval(progressDotsTimer);
      progressDotsTimer = null;
    }
  }

  function applyToastShell(el, palette) {
    Object.assign(el.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: "2147483647",
      maxWidth: "200px",
      minWidth: "120px",
      padding: "8px 10px",
      borderRadius: "8px",
      background: palette.background,
      color: palette.color,
      border: palette.border,
      font: '12px/1.3 "Avenir Next", "Segoe UI", "Helvetica Neue", Helvetica, sans-serif',
      fontWeight: "500",
      letterSpacing: "-0.01em",
      boxShadow: "0 3px 12px rgba(26, 26, 26, 0.08)",
      transition: "opacity .15s ease",
      pointerEvents: "none",
    });
  }

  /**
   * In-progress chip — stays up until showToast/dismissProgress.
   * Text only: "Annotating" + cycling dots (no bar).
   */
  function showProgress(base = "Annotating") {
    clearToastHide();
    clearProgressDots();
    const el = ensureToastHost();
    el.dataset.encordToastMode = "progress";
    applyToastShell(el, {
      background: "#f2f0e9",
      color: "#1a1a1a",
      border: "1px solid rgba(26, 26, 26, 0.12)",
    });
    let step = 0;
    const paint = () => {
      el.textContent = base + ".".repeat((step % 3) + 1);
      step += 1;
    };
    paint();
    el.style.opacity = "1";
    progressDotsTimer = setInterval(paint, 400);
  }

  function dismissProgress() {
    const el = document.getElementById("encord-camera-layout-toast");
    if (!el || el.dataset.encordToastMode !== "progress") return;
    clearToastHide();
    clearProgressDots();
    el.style.opacity = "0";
    setTimeout(() => {
      if (el.dataset.encordToastMode === "progress") el.remove();
    }, 200);
  }

  function showToast(message, kind = "info") {
    clearToastHide();
    clearProgressDots();
    const el = ensureToastHost();
    el.textContent = message;
    el.dataset.encordToastMode = "toast";
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
    applyToastShell(el, palette);
    el.style.opacity = "1";
    toastHideTimer = setTimeout(() => {
      el.style.opacity = "0";
      toastHideTimer = setTimeout(() => {
        if (el.dataset.encordToastMode === "toast") el.remove();
        toastHideTimer = null;
      }, 200);
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

  /** Project + data unit — used to reset one-shot auto annotation on episode change. */
  function getEpisodeKey() {
    const m = location.pathname.match(/\/label_editor\/([^/]+\/[^/]+)/);
    return m ? m[1] : location.pathname;
  }

  function resetAutoAnnotateIfEpisodeChanged() {
    const key = getEpisodeKey();
    if (key !== autoAnnotatedEpisodeKey) {
      autoAnnotatedEpisodeKey = key;
      autoAnnotatedOnce = false;
    }
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
   * Pass / Fail / Incomplete — allow glued hotkey suffix (PassY, FailU, IncompleteI).
   */
  function stepOutcomeChoiceKey(raw) {
    const t = normalizeLabel(raw).replace(/\s+/g, "");
    const m = t.match(/^(pass|fail|incomplete)([yui])?$/i);
    return m ? m[1].toLowerCase() : null;
  }

  function isStepOutcomeChoiceLabel(raw) {
    return !!stepOutcomeChoiceKey(raw);
  }

  function isRadioChecked(el) {
    if (!el) return false;
    const input =
      (el.matches?.('input[type="radio"]') && el) ||
      el.querySelector?.('input[type="radio"]') ||
      null;
    if (input?.checked) return true;
    const wrap = el.closest?.("label.ant-radio-wrapper, label, [role='radio']") || el;
    if (wrap.classList?.contains("ant-radio-wrapper-checked")) return true;
    if (wrap.querySelector?.(".ant-radio-checked, [aria-checked='true']")) return true;
    if (wrap.getAttribute?.("aria-checked") === "true") return true;
    return false;
  }

  /**
   * Step Outcome radios: Pass / Fail / Incomplete (not Step identity, not Grade).
   * Distinguishes from Grade's incomplete by requiring Pass or Fail in the same group.
   */
  function scrapeStepOutcomeOptions(root) {
    if (!root) return [];

    // Prefer the section under an explicit "Step Outcome" heading
    const heading = [...root.querySelectorAll("div, span, label, p, h1, h2, h3, h4")].find((el) => {
      if (isInTimelineChrome(el) || isInLabelsPane(el)) return false;
      const t = normalizeLabel(el.textContent);
      return t.length > 0 && t.length < 40 && /^step\s*outcome$/i.test(t);
    });
    if (heading) {
      let section = heading.parentElement;
      for (let i = 0; i < 5 && section; i += 1) {
        const labels = [...section.querySelectorAll("label.ant-radio-wrapper, label, [role='radio']")]
          .filter((el) => {
            if (isInTimelineChrome(el) || isInLabelsPane(el)) return false;
            const t = normalizeLabel(el.textContent);
            return t.length > 0 && t.length < 28 && isStepOutcomeChoiceLabel(t);
          })
          .map((el, order) => ({
            label: stepOutcomeChoiceKey(el.textContent),
            el,
            order,
          }));
        const names = new Set(labels.map((o) => o.label));
        if (names.has("incomplete") && (names.has("pass") || names.has("fail"))) {
          const dedup = [];
          const seen = new Set();
          for (const o of labels) {
            if (seen.has(o.label)) continue;
            seen.add(o.label);
            dedup.push(o);
          }
          return dedup;
        }
        section = section.parentElement;
      }
    }

    const labels = [...root.querySelectorAll("label.ant-radio-wrapper, label, [role='radio']")].filter(
      (el) => {
        if (isInTimelineChrome(el) || isInLabelsPane(el)) return false;
        const t = normalizeLabel(el.textContent);
        return t.length > 0 && t.length < 28 && isStepOutcomeChoiceLabel(t);
      }
    );
    if (!labels.length) return [];

    const groups = new Map();
    for (const el of labels) {
      const parent =
        el.closest('[role="radiogroup"], .ant-radio-group, [class*="Radio"]') ||
        el.closest('[data-testid]') ||
        el.parentElement?.parentElement ||
        el.parentElement;
      const key = parent || el;
      if (!groups.has(key)) groups.set(key, []);
      const keyLabel = stepOutcomeChoiceKey(el.textContent);
      if (!keyLabel || groups.get(key).some((o) => o.label === keyLabel)) continue;
      groups.get(key).push({ label: keyLabel, el, order: groups.get(key).length });
    }

    // Prefer a group that looks like Step Outcome (has Incomplete + Pass or Fail)
    let best = null;
    for (const opts of groups.values()) {
      const names = new Set(opts.map((o) => o.label));
      if (!names.has("incomplete")) continue;
      if (!names.has("pass") && !names.has("fail")) continue;
      if (!best || opts.length > best.length) best = opts;
    }
    return best || [];
  }

  function findStepOutcomeIncompleteChecked() {
    for (const root of stepSelectionRoots()) {
      const opts = scrapeStepOutcomeOptions(root);
      const hit = opts.find((o) => o.label === "incomplete");
      if (hit && isRadioChecked(hit.el)) return { ok: true, hit, options: opts.map((o) => o.label) };
    }
    return { ok: false };
  }

  /** Step identity = first entry in ordered Step options (Step 1). */
  function selectFirstStepIdentityOption() {
    for (const root of stepSelectionRoots()) {
      const opts = scrapeOrderedStepOptions(root);
      if (!opts.length) continue;
      const first = firstDefinedFromSteps(opts);
      if (!first?.el) continue;
      if (isRadioChecked(first.el)) {
        return {
          ok: true,
          via: "already-checked",
          stepNum: first.stepNum,
          label: first.label,
        };
      }
      if (forceClickRadioEl(first.el)) {
        return {
          ok: true,
          via: "step-identity-radio",
          stepNum: first.stepNum,
          label: first.label,
        };
      }
    }
    return { ok: false, error: "first-step-not-found" };
  }

  /**
   * S2 attribute = Step Outcome → Incomplete.
   * Never use hotkey I — that is also Grade Incomplete and would mark G2.
   */
  function selectIncompleteStepOption() {
    for (const root of stepSelectionRoots()) {
      const opts = scrapeStepOutcomeOptions(root);
      if (!opts.length) continue;
      const hit = opts.find((o) => o.label === "incomplete");
      if (!hit) continue;
      if (forceClickRadioEl(hit.el)) {
        return {
          ok: true,
          via: "step-outcome-radio",
          label: "incomplete",
          incomplete: true,
          options: opts.map((o) => o.label),
        };
      }
    }
    // Do NOT press "i" — Grade Incomplete shares that hotkey and would set G2.
    return { ok: false, error: "step-outcome-incomplete-not-found" };
  }

  /**
   * S2 value: Step 1 (first identity) + Step Outcome Incomplete, then Done/Esc.
   * Call only with the S2 Step instance selected — never while Grade is focused.
   */
  async function applyIncompleteStepToRange(range) {
    if (!range?.el) return { ok: false, error: "no-range" };
    try {
      range.el.click();
    } catch {
      return { ok: false, error: "click-failed" };
    }
    await sleep(W.panel);

    let lastStepId = { ok: false };
    let lastOutcome = { ok: false };
    for (let i = 0; i < 3; i += 1) {
      try {
        range.el.click();
      } catch {
        /* ignore */
      }
      await sleep(W.med);
      const instance = normalizeLabel(
        document.querySelector('[data-testid="instance-name"]')?.textContent || ""
      ).toLowerCase();
      if (instance !== "step") {
        try {
          range.el.click();
        } catch {
          /* ignore */
        }
        await sleep(W.panel);
      }

      lastStepId = selectFirstStepIdentityOption();
      await sleep(W.med);
      lastOutcome = selectIncompleteStepOption();
      await sleep(W.panel);
      const checked = findStepOutcomeIncompleteChecked();
      if (checked.ok && lastStepId.ok) {
        await blurRangeFrameInputs();
        await sleep(W.short);
        const done = clickDoneIfPresent();
        if (!done) pressEditorKey("Escape");
        await sleep(W.med);
        return {
          ok: true,
          via: lastOutcome.via || "step-outcome-radio",
          label: "incomplete",
          stepIdentity: lastStepId,
          selected: lastOutcome,
          checked,
          done: !!done,
        };
      }
      await sleep(W.short);
    }
    return {
      ok: false,
      error: "step-outcome-incomplete-not-applied",
      stepIdentity: lastStepId,
      selected: lastOutcome,
      label: rangeLabel(range.el),
    };
  }

  /** After full sync: select existing G1 only — never arm Trajectory create. */
  async function selectGradeForOperator(_tailStart) {
    const grade = findPrimaryGradeRange();
    if (!grade?.el) {
      return { ok: false, skipped: true, reason: "no-g1" };
    }
    try {
      grade.el.click();
    } catch {
      return { ok: false, error: "g1-click-failed" };
    }
    await sleep(W.med);
    return { ok: true, grade, via: "g1-click" };
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

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        active.el.click();
      } catch {
        return { ok: false, error: "click-failed" };
      }
      await sleep(W.panel);
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
        await sleep(W.med);
      } else {
        const shortBy = Math.max(1, Math.min(4, targetEnd - geo.endFrame));
        adjustRightSide(shortBy);
        await sleep(W.med);
      }
      const bounds = findRangeBoundInputs();
      if (bounds) {
        // Keep start; only rewrite end so we don't disturb G1 abutment.
        await setInputFrame(bounds.end, targetEnd);
        await sleep(W.panel);
      }
      // Fill to playhead at target end as a last push for episode-end shorts
      if (attempt >= 1) {
        const jumped = await goToFrame(targetEnd);
        await sleep(W.short);
        try {
          active.el.click();
        } catch {
          /* ignore */
        }
        await sleep(W.med);
        if (jumped.ok) {
          clickFillToPlayhead();
          await sleep(W.settle);
        } else if (total && targetEnd >= total - 1) {
          // Jump to last navigable frame then nudge end past it via inputs/adjust
          await goToFrame(Math.max(0, total - 1));
          await sleep(W.short);
          try {
            active.el.click();
          } catch {
            /* ignore */
          }
          await sleep(W.short);
          clickFillToPlayhead();
          await sleep(W.settle);
          adjustRightSide(1);
          await sleep(W.med);
        }
        const bounds2 = findRangeBoundInputs();
        if (bounds2) {
          const startKeep = Number(String(bounds2.start.value || "").replace(/[^\d]/g, ""));
          if (Number.isFinite(startKeep)) await setInputFrame(bounds2.start, startKeep);
          await setInputFrame(bounds2.end, targetEnd);
          await sleep(W.panel);
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
      }, 20);
    });
  }

  async function goToFrame(frame) {
    const target = Math.max(0, Math.floor(frame));
    const already = getCurrentFrame();
    if (already != null && Math.abs(already - target) <= FRAME_EPS) {
      return { ok: true, frame: already, via: "already" };
    }

    // 1) MAIN-world React path
    let result = await pageGotoFrame(target);
    for (let i = 0; i < 10; i += 1) {
      await sleep(W.tick);
      const cur = getCurrentFrame();
      if (cur != null && Math.abs(cur - target) <= FRAME_EPS) {
        return { ok: true, frame: cur, via: "page-world" };
      }
    }

    // 2) DOM/Ant input fallback
    const input = document.querySelector('[data-testid="content-navigation-frame-input"]');
    if (input) {
      input.focus();
      await sleep(W.tick);
      input.select?.();
      setNativeInputValue(input, String(target));
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
      );
      input.blur();
      for (let i = 0; i < 10; i += 1) {
        await sleep(W.tick);
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
      for (let i = 0; i < 10; i += 1) {
        await sleep(W.tick);
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
    await sleep(W.short);
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
    await sleep(W.short);

    const modeTag =
      shell?.querySelector?.('[data-testid="editor-mode-status-tag"]') ||
      document.querySelector('[data-testid="editor-mode-status-tag"]');
    clickEl(modeTag);
    await sleep(W.short);

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
    await sleep(W.short);
    pressEditorKey("Escape");
    await sleep(W.short);
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
   * -1, 0, 1, 3, 4, 5, complete, incomplete.
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
      if (!/^-?\d+$/.test(t) && !/^(complete|incomplete)$/i.test(t)) return;
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

  function gradeValueRoots() {
    return [
      document.querySelector('[data-testid="object-left-panel"]'),
      document.querySelector('[data-testid="editor-sider"]'),
      document.querySelector('[data-testid="editor-sider-ontology-list"]')?.parentElement,
    ].filter(Boolean);
  }

  function findGradeValueChecked(wantLabel) {
    const re = new RegExp(`^${wantLabel}$`, "i");
    for (const root of gradeValueRoots()) {
      const opts = scrapeOrderedGradeValueOptions(root);
      const hit = opts.find((o) => re.test(o.label));
      if (hit && isRadioChecked(hit.el)) {
        return { ok: true, hit, options: opts.map((o) => o.label) };
      }
    }
    return { ok: false };
  }

  /** Click a radio/label even when ant-tree marks nodes disabled. */
  function forceClickRadioEl(el) {
    if (!el) return false;
    const label = el.closest?.("label") || (el.matches?.("label") ? el : null) || el;
    const input =
      (el.matches?.('input[type="radio"]') && el) ||
      el.querySelector?.('input[type="radio"]') ||
      label?.querySelector?.('input[type="radio"]') ||
      null;
    try {
      if (input) {
        input.disabled = false;
        input.removeAttribute?.("disabled");
        input.click();
      }
    } catch {
      /* ignore */
    }
    try {
      label.click();
    } catch {
      /* ignore */
    }
    try {
      const rect = (label || el).getBoundingClientRect();
      const x = rect.left + Math.min(12, Math.max(4, rect.width / 2));
      const y = rect.top + rect.height / 2;
      for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
        (label || el).dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window })
        );
      }
    } catch {
      /* ignore */
    }
    return true;
  }

  /**
   * G2 Grade value = Incomplete (last option: -1…5, incomplete).
   * G1 deliberately leaves Grade unselected. Never use hotkey I during S2.
   */
  function selectIncompleteGradeOption() {
    for (const root of gradeValueRoots()) {
      const opts = scrapeOrderedGradeValueOptions(root);
      if (!opts.length) continue;
      // Prefer Incomplete in a Grade list (has numeric options) — not Step Outcome
      const hasNumeric = opts.some((o) => /^-?\d+$/.test(o.label));
      const hit = opts.find((o) => /^incomplete$/i.test(o.label));
      if (!hit) continue;
      if (!hasNumeric && opts.length <= 2) continue;
      if (forceClickRadioEl(hit.el)) {
        return {
          ok: true,
          via: "grade-incomplete-radio",
          label: "incomplete",
          options: opts.map((o) => o.label),
        };
      }
    }
    return { ok: false, error: "grade-incomplete-not-found", options: null };
  }

  /**
   * G2 only: with Trajectory/G2 selected, set Grade Incomplete via hotkey I,
   * then Done / Escape to commit. Call only after G2 bounds are final.
   */
  async function applyIncompleteGradeToRange(range) {
    if (!range?.el) return { ok: false, error: "no-range" };
    try {
      range.el.click();
    } catch {
      return { ok: false, error: "click-failed" };
    }
    await sleep(W.panel);
    await blurRangeFrameInputs();
    await sleep(W.short);

    // Prefer visible Incomplete radio; fall back to hotkey I (Grade panel only)
    let via = "hotkey-i";
    const radio = selectIncompleteGradeOption();
    if (radio.ok) {
      via = radio.via || "radio";
    } else {
      pressEditorKey("i");
    }
    await sleep(W.panel);

    const checked = findGradeValueChecked("incomplete");
    const done = clickDoneIfPresent();
    if (!done) pressEditorKey("Escape");
    await sleep(W.med);

    return {
      ok: checked.ok || radio.ok || via === "hotkey-i",
      via,
      label: "incomplete",
      checked,
      radio,
      done: !!done,
    };
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
      await sleep(W.short);
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
        await sleep(W.short);
        return { ok: true, via: "react", page };
      }
    }

    input.focus();
    await sleep(W.tick);
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
      }, 20);
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
   * Lean resize when the instance already has a real span (not a pin).
   * Click → write Range inputs once → small Adjust nudge if off by ≤2.
   * Does not Fill. Caller falls back to resizeViaRangeInputs when this fails.
   */
  async function setRangeFast(range, startFrame, endFrame, opts = {}) {
    const total = getTotalFrames();
    let wantStart = Math.max(0, Math.floor(startFrame));
    let wantEnd = Math.max(wantStart, Math.floor(endFrame));
    if (total) {
      wantEnd = Math.min(wantEnd, total);
      wantStart = Math.min(wantStart, wantEnd);
    }
    if (!range?.el) return { ok: false, error: "no-range", via: "fast" };

    const lockTail = opts.lockToSelectRange === true || (opts.matchStart != null && opts.matchStart > 1);

    function refresh() {
      if (opts.refresh) return opts.refresh();
      if (lockTail && range.el?.isConnected) {
        const live = describeRange(range.el);
        return live ? withGradeFrames(live, total) : withGradeFrames(range, total);
      }
      if (wantStart <= 1) return findPrimaryGradeRange();
      return (
        findGradeNearStart(opts.matchStart ?? wantStart, total) ||
        (range.el?.isConnected
          ? withGradeFrames(describeRange(range.el) || range, total)
          : null)
      );
    }

    try {
      range.el.click();
    } catch {
      return { ok: false, error: "click-failed", via: "fast" };
    }
    await sleep(W.med);

    let active = refresh() || withGradeFrames(describeRange(range.el) || range, total);
    let geo = timelineBounds(active);
    if (!geo || geo.span <= 2) {
      return { ok: false, error: "needs-expand", via: "fast", geo, range: active };
    }

    if (timelineMatches(wantStart, wantEnd, active)) {
      await blurRangeFrameInputs();
      return {
        ok: true,
        via: "fast-already",
        after: geo,
        want: { startFrame: wantStart, endFrame: wantEnd },
        range: active,
      };
    }

    let bounds = findRangeBoundInputs();
    if (!bounds) {
      try {
        range.el.click();
      } catch {
        /* ignore */
      }
      await sleep(W.med);
      bounds = findRangeBoundInputs();
    }
    if (!bounds) return { ok: false, error: "no-range-inputs", via: "fast", geo };

    const readVals = () => ({
      startVal: Number(String(bounds.start.value || "").replace(/[^\d]/g, "")),
      endVal: Number(String(bounds.end.value || "").replace(/[^\d]/g, "")),
    });
    let cur = readVals();
    if (cur.startVal !== wantStart || cur.endVal !== wantEnd) {
      await setInputFrame(bounds.start, wantStart);
      await sleep(W.short);
      bounds = findRangeBoundInputs() || bounds;
      await setInputFrame(bounds.end, wantEnd);
      await sleep(W.panel);
    }

    await blurRangeFrameInputs();
    await sleep(W.short);
    active = refresh() || active;
    geo = timelineBounds(active);

    // Small nudge only — keep lean path short
    if (geo && !timelineMatches(wantStart, wantEnd, active)) {
      const startDelta = wantStart - geo.startFrame;
      const endDelta = wantEnd - geo.endFrame;
      if (Math.abs(startDelta) > 0 && Math.abs(startDelta) <= 2) {
        adjustLeftSide(startDelta);
        await sleep(W.short);
      }
      if (Math.abs(endDelta) > 0 && Math.abs(endDelta) <= 2) {
        adjustRightSide(endDelta);
        await sleep(W.short);
      }
      bounds = findRangeBoundInputs();
      if (bounds && !timelineMatches(wantStart, wantEnd, active)) {
        await setInputFrame(bounds.start, wantStart);
        await sleep(W.tick);
        bounds = findRangeBoundInputs() || bounds;
        await setInputFrame(bounds.end, wantEnd);
        await sleep(W.med);
      }
      await blurRangeFrameInputs();
      await sleep(W.short);
      active = refresh() || active;
      geo = timelineBounds(active);
    }

    const ok = timelineMatches(wantStart, wantEnd, active);
    return {
      ok,
      via: ok ? "fast" : "fast-mismatch",
      after: geo,
      want: { startFrame: wantStart, endFrame: wantEnd },
      range: active,
      error: ok ? undefined : "fast-timeline-mismatch",
    };
  }

  /**
   * Prefer setRangeFast when the bar already has a real span.
   * expandPinToRange only for pins (span≤2) — never re-Fill an existing bar
   * (that was stacking fast-fail + expand + full ≈ 2s on G1).
   */
  async function resizeRangeSmart(startFrame, endFrame, opts = {}) {
    const total = getTotalFrames();
    const matchStart = opts.matchStart != null ? opts.matchStart : startFrame;
    const lockTail = opts.lockToSelectRange === true || matchStart > 1;

    let candidate = opts.selectRange || null;
    if (!candidate?.el) {
      candidate =
        matchStart <= 1
          ? findPrimaryGradeRange()
          : findGradeNearStart(matchStart, total);
    } else if (candidate.el) {
      const live = describeRange(candidate.el);
      candidate = live ? withGradeFrames(live, total) : withGradeFrames(candidate, total);
    }

    const geo = candidate ? timelineBounds(candidate) : null;

    // Existing real bar: lean only, then full — never expandPin
    if (geo && geo.span > 2) {
      if (!(lockTail && geo.startFrame <= 1 && matchStart > 2)) {
        const fast = await setRangeFast(candidate, startFrame, endFrame, opts);
        if (fast.ok) return { ...fast, path: "fast" };
      }
      const full = await resizeViaRangeInputs(startFrame, endFrame, opts);
      return { ...full, path: full.via || "full-after-fast" };
    }

    // Pin / tiny span: expand once, then full only if needed
    if (candidate?.el) {
      const expanded = await expandPinToRange(candidate, startFrame, endFrame, opts);
      if (expanded.ok) return { ...expanded, path: expanded.via || "expand" };
    }

    const full = await resizeViaRangeInputs(startFrame, endFrame, opts);
    return { ...full, path: full.via || "full" };
  }

  /** Click range, jump, Fill-to-playhead — used to grow pins into real spans. */
  async function fillRangeToFrame(range, frame, opts = {}) {
    if (!range?.el) return { ok: false };
    const before = timelineBounds(range);
    const jumped = await goToFrame(frame);
    await sleep(W.tick);
    try {
      range.el.click();
    } catch {
      /* ignore */
    }
    await sleep(W.short);
    if (jumped.ok) clickFillToPlayhead();
    // Poll for geometry change instead of fixed settle
    await waitUntil(() => {
      const live = range.el ? describeRange(range.el) : null;
      const geo = live ? timelineBounds(withGradeFrames(live, getTotalFrames()) || range) : null;
      if (!geo) return false;
      if (opts.wantSpan && geo.span > 2) return true;
      if (opts.wantEnd != null && geo.endFrame >= opts.wantEnd) return true;
      if (opts.wantStart != null && Math.abs(geo.startFrame - opts.wantStart) <= 1) return true;
      if (before && (geo.span !== before.span || geo.startFrame !== before.startFrame || geo.endFrame !== before.endFrame)) {
        return true;
      }
      return false;
    }, { timeout: W.settle + 80, interval: W.tick });
    return { ok: jumped.ok, jumped: jumped.ok };
  }

  /**
   * Grow a pin/short bar to [start,end], then commit exact bounds.
   * Success always requires timelineMatches (BOUND_EPS) — never “close enough”.
   * Pin at start → Fill at end; otherwise Fill at start then end; then exact inputs.
   */
  async function expandPinToRange(range, startFrame, endFrame, opts = {}) {
    const total = getTotalFrames();
    let wantStart = Math.max(0, Math.floor(startFrame));
    let wantEnd = Math.max(wantStart, Math.floor(endFrame));
    if (total) {
      wantEnd = Math.min(wantEnd, total);
      wantStart = Math.min(wantStart, wantEnd);
    }
    if (!range?.el) return { ok: false, error: "no-range", via: "expand-pin" };

    const lockTail = opts.lockToSelectRange === true || (opts.matchStart != null && opts.matchStart > 1);

    function refresh() {
      if (opts.refresh) return opts.refresh();
      if (lockTail && range.el?.isConnected) {
        const live = describeRange(range.el);
        return live ? withGradeFrames(live, total) : withGradeFrames(range, total);
      }
      if (wantStart <= 1) return findPrimaryGradeRange();
      return (
        findGradeNearStart(opts.matchStart ?? wantStart, total) ||
        (range.el?.isConnected
          ? withGradeFrames(describeRange(range.el) || range, total)
          : null)
      );
    }

    try {
      range.el.click();
    } catch {
      return { ok: false, error: "click-failed", via: "expand-pin" };
    }
    await sleep(W.short);

    let active = refresh() || withGradeFrames(describeRange(range.el) || range, total);
    let geo = timelineBounds(active);
    const pinAtStart =
      geo && geo.span <= 2 && Math.abs((geo.startFrame ?? -1) - wantStart) <= 1;

    if (pinAtStart) {
      await fillRangeToFrame(active || range, wantEnd, { wantEnd, wantSpan: true });
      active = refresh() || active;
      geo = timelineBounds(active);
    } else {
      // Critical: Fill at wantStart first (G2 pin lives at episode end — Fill-at-end is a no-op)
      if (!geo || geo.span <= 2 || Math.abs((geo.startFrame ?? -1) - wantStart) > BOUND_EPS) {
        await fillRangeToFrame(active || range, wantStart, { wantStart, wantSpan: true });
        active = refresh() || active;
        geo = timelineBounds(active);
      }
      if (!geo || (geo.endFrame ?? -1) < wantEnd) {
        await fillRangeToFrame(active || range, wantEnd, { wantEnd });
        active = refresh() || active;
        geo = timelineBounds(active);
      }
      if (!geo || geo.span <= 2) {
        await fillRangeToFrame(active || range, wantEnd, { wantSpan: true, wantEnd });
        active = refresh() || active;
        geo = timelineBounds(active);
      }
    }

    if (timelineMatches(wantStart, wantEnd, active)) {
      await blurRangeFrameInputs();
      return { ok: true, via: "expand+fill", after: geo, range: active };
    }

    // Exact commit via Range inputs (+ Adjust only to reach exact match)
    if (active?.el) {
      try {
        active.el.click();
      } catch {
        /* ignore */
      }
      await sleep(W.short);
      let bounds = findRangeBoundInputs();
      if (!bounds) {
        await waitUntil(() => !!findRangeBoundInputs(), { timeout: 200, interval: W.tick });
        bounds = findRangeBoundInputs();
      }
      if (bounds) {
        await setInputFrame(bounds.start, wantStart);
        await sleep(W.tick);
        bounds = findRangeBoundInputs() || bounds;
        await setInputFrame(bounds.end, wantEnd);
        await sleep(W.short);
      }
      active = refresh() || active;
      geo = timelineBounds(active);
      if (geo && !timelineMatches(wantStart, wantEnd, active)) {
        const startDelta = wantStart - geo.startFrame;
        const endDelta = wantEnd - geo.endFrame;
        if (Math.abs(startDelta) > 0 && Math.abs(startDelta) <= 40) {
          adjustLeftSide(startDelta);
          await sleep(W.short);
        }
        if (Math.abs(endDelta) > 0 && Math.abs(endDelta) <= 40) {
          adjustRightSide(endDelta);
          await sleep(W.short);
        }
        bounds = findRangeBoundInputs();
        if (bounds) {
          await setInputFrame(bounds.start, wantStart);
          await sleep(W.tick);
          bounds = findRangeBoundInputs() || bounds;
          await setInputFrame(bounds.end, wantEnd);
          await sleep(W.short);
        }
      }
      await blurRangeFrameInputs();
      await sleep(W.tick);
      active = refresh() || active;
      if (timelineMatches(wantStart, wantEnd, active)) {
        return {
          ok: true,
          via: "expand+medium",
          after: timelineBounds(active),
          range: active,
        };
      }
    }

    return {
      ok: false,
      error: "expand-pin-mismatch",
      via: "expand-pin",
      after: timelineBounds(active),
      range: active,
    };
  }

  /**
   * Exact G1 restore when start is already 0 and end is short by 1–2 frames.
   * Only writes/adjusts the end; succeeds only if timelineMatches(0, wantEnd).
   */
  async function quickRestorePrimaryEnd(wantEnd) {
    const want = Math.max(0, Math.floor(wantEnd));
    const primary = findPrimaryGradeRange();
    if (!primary?.el) return { ok: false, error: "no-primary" };
    const geo0 = timelineBounds(primary);
    if (!geo0) return { ok: false, error: "no-geo" };
    const startOk = Math.abs((geo0.startFrame ?? -1) - 0) <= BOUND_EPS;
    const shortBy = want - (geo0.endFrame ?? -1);
    if (!startOk || shortBy < 1 || shortBy > 2) {
      return { ok: false, error: "not-quick-candidate", geo: geo0, shortBy };
    }

    try {
      primary.el.click();
    } catch {
      return { ok: false, error: "click-failed" };
    }
    await sleep(W.short);
    await waitUntil(() => !!findRangeBoundInputs(), { timeout: 200, interval: W.tick });

    adjustRightSide(shortBy);
    await sleep(W.short);
    let bounds = findRangeBoundInputs();
    if (bounds) {
      await setInputFrame(bounds.end, want);
      await sleep(W.short);
    }
    await blurRangeFrameInputs();
    await sleep(W.tick);

    const primary1 = findPrimaryGradeRange() || primary;
    if (timelineMatches(0, want, primary1)) {
      return { ok: true, via: "quick-end-exact", after: timelineBounds(primary1), shortBy };
    }

    // One more exact end write
    try {
      primary1.el.click();
    } catch {
      /* ignore */
    }
    await sleep(W.short);
    bounds = findRangeBoundInputs();
    if (bounds) {
      await setInputFrame(bounds.end, want);
      await sleep(W.short);
    }
    adjustRightSide(1);
    await sleep(W.short);
    bounds = findRangeBoundInputs();
    if (bounds) {
      await setInputFrame(bounds.end, want);
      await sleep(W.short);
    }
    await blurRangeFrameInputs();
    await sleep(W.tick);

    const primary2 = findPrimaryGradeRange() || primary1;
    const ok = timelineMatches(0, want, primary2);
    return {
      ok,
      via: ok ? "quick-end-exact" : "quick-end-miss",
      after: timelineBounds(primary2),
      shortBy,
      error: ok ? undefined : "quick-end-not-exact",
    };
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
      await sleep(W.med);
      return true;
    }

    async function writeInputs(start, end) {
      let bounds = findRangeBoundInputs();
      if (!bounds) {
        await selectGrade();
        bounds = findRangeBoundInputs();
      }
      if (!bounds) return { ok: false, error: "no-range-inputs" };

      const readVals = () => {
        const startEl = document.querySelector('input[aria-label="Range start"]');
        const endEl = document.querySelector('input[aria-label="Range end"]');
        return {
          startVal: Number(String(startEl?.value || "").replace(/[^\d]/g, "")),
          endVal: Number(String(endEl?.value || "").replace(/[^\d]/g, "")),
        };
      };

      // Skip writes when inputs already match
      let cur = readVals();
      if (cur.startVal === start && cur.endVal === end) {
        return { ok: true, ...cur, skipped: true };
      }

      await setInputFrame(bounds.start, start);
      await sleep(W.short);
      bounds = findRangeBoundInputs() || bounds;
      await setInputFrame(bounds.end, end);
      await sleep(W.short);
      cur = readVals();
      if (cur.startVal === start && cur.endVal === end) {
        return { ok: true, ...cur };
      }

      // Second pass only if first didn't stick
      bounds = findRangeBoundInputs() || bounds;
      await setInputFrame(bounds.start, start);
      await sleep(W.short);
      bounds = findRangeBoundInputs() || bounds;
      await setInputFrame(bounds.end, end);
      await sleep(W.med);
      return { ok: true, ...readVals() };
    }

    async function fillAt(frame) {
      const jumped = await goToFrame(frame);
      await sleep(W.short);
      const selected = await selectGrade();
      if (!selected) {
        return { jumped: jumped.ok, via: null, geo: null, error: "fill-no-select" };
      }
      const via = jumped.ok ? clickFillToPlayhead() : null;
      await sleep(W.settle);
      active = refreshActive() || active;
      return { jumped: jumped.ok, via, geo: timelineBounds(active) };
    }

    if (!(await selectGrade()) && !findRangeBoundInputs()) {
      return { ok: false, error: lockTail ? "no-tail-grade" : "no-grade" };
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await selectGrade();
      active = refreshActive() || active;
      let geo = timelineBounds(active);

      // Already correct — skip fill/write churn
      if (timelineMatches(wantStart, wantEnd, active)) {
        await blurRangeFrameInputs();
        await sleep(W.short);
        active = refreshActive() || active;
        if (timelineMatches(wantStart, wantEnd, active)) {
          return {
            ok: true,
            via: "already-matched",
            after: timelineBounds(active),
            want: { startFrame: wantStart, endFrame: wantEnd },
            attempts: attempt + 1,
            framesBlurred: true,
          };
        }
      }

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
      await sleep(W.panel);
      active = refreshActive() || active;
      geo = timelineBounds(active);

      // 3) Nudge with Adjust left/right (⌥←/→, ⌥⇧←/→) if still off
      if (geo && !timelineMatches(wantStart, wantEnd, active)) {
        await selectGrade();
        const startDelta = wantStart - geo.startFrame;
        const endDelta = wantEnd - geo.endFrame;
        if (Math.abs(startDelta) > 0 && Math.abs(startDelta) <= 40) {
          adjustLeftSide(startDelta);
          await sleep(W.med);
        }
        if (Math.abs(endDelta) > 0 && Math.abs(endDelta) <= 40) {
          adjustRightSide(endDelta);
          await sleep(W.med);
        }
        active = refreshActive() || active;
        geo = timelineBounds(active);
        if (!timelineMatches(wantStart, wantEnd, active)) {
          await writeInputs(wantStart, wantEnd);
          await sleep(W.med);
        }
      }

      // 4) Last resort: shrink end with Adjust
      active = refreshActive() || active;
      geo = timelineBounds(active);
      if (geo && geo.endFrame > wantEnd && geo.endFrame - wantEnd <= 60) {
        await selectGrade();
        adjustRightSide(wantEnd - geo.endFrame);
        await sleep(W.panel);
        await writeInputs(wantStart, wantEnd);
        await sleep(W.med);
      }

      // 5) Encord often settles one frame short of Range end — extend if short by 1–2
      active = refreshActive() || active;
      geo = timelineBounds(active);
      if (geo && geo.endFrame < wantEnd && wantEnd - geo.endFrame <= 2) {
        const shortBy = wantEnd - geo.endFrame;
        await selectGrade();
        for (let n = 0; n < shortBy + 1; n += 1) {
          adjustRightSide(1);
          await sleep(W.med);
          await writeInputs(wantStart, wantEnd);
          await sleep(W.med);
          active = refreshActive() || active;
          geo = timelineBounds(active);
          if (geo && Math.abs(geo.endFrame - wantEnd) <= BOUND_EPS) break;
        }
      }

      active = refreshActive() || active;
      if (timelineMatches(wantStart, wantEnd, active)) {
        await blurRangeFrameInputs();
        await sleep(W.med);
        // Re-read after blur — Encord can snap end back by 1 frame on commit
        active = refreshActive() || active;
        geo = timelineBounds(active);
        if (geo && geo.endFrame < wantEnd && wantEnd - geo.endFrame <= 2) {
          await selectGrade();
          adjustRightSide(wantEnd - geo.endFrame);
          await sleep(W.med);
          await writeInputs(wantStart, wantEnd);
          await sleep(W.med);
          await blurRangeFrameInputs();
          await sleep(W.med);
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
    if (existing?.el) {
      try {
        existing.el.click();
      } catch {
        /* ignore */
      }
      for (let i = 0; i < 12; i += 1) {
        await sleep(W.tick);
        if (findRangeBoundInputs()) return { ok: true, via: "clicked-existing" };
      }
      // Primary Grade exists — never create another Trajectory (was burning ~800ms + spoiling G1)
      return { ok: true, via: "existing-no-inputs", created: false };
    }

    await clearInstanceSelection();
    // Re-assert preferred tile after deselect — ontology clicks must not land on a wrist cam.
    await focusPreferredGradeTile();
    await sleep(W.short);
    const activated = activateTrajectoryClass();
    if (!activated) return { ok: false, error: "no-trajectory-class" };
    await sleep(W.panel);

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
    await sleep(W.med);

    // Prefer a pin at frame 0 when creating, but Range inputs always overwrite to 0…end.
    // If jump fails, still create a throwaway pin — do NOT use set-start/end-to-current as final.
    const atZero = await goToFrame(0);
    document.activeElement?.blur?.();
    await sleep(W.short);

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
    await waitUntil(() => !!findPrimaryGradeRange() || !!findRangeBoundInputs(), {
      timeout: W.create,
      interval: W.tick,
    });

    const pin = findPrimaryGradeRange();
    if (pin) {
      try {
        pin.el.click();
      } catch {
        /* ignore */
      }
      await waitUntil(() => !!findRangeBoundInputs(), { timeout: W.panel, interval: W.tick });
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
    await sleep(W.short);
    const activated = activateTrajectoryClass();
    if (!activated) return { ok: false, error: "no-trajectory-class" };
    await sleep(W.panel);

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
    await sleep(W.med);

    const jumped = await goToFrame(at);
    document.activeElement?.blur?.();
    await sleep(W.short);

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
    await waitUntil(
      () =>
        !!findGradeNearStart(at, total) ||
        listGradeRanges().some((r) => !before.has(r.el)) ||
        !!findRangeBoundInputs(),
      { timeout: W.create, interval: W.tick }
    );

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
      await waitUntil(() => !!findRangeBoundInputs(), { timeout: W.panel, interval: W.tick });
      pin = findGradeNearStart(at, total) || pin;
    }

    // Incomplete is applied after G2 bounds are final (not at pin-create time).
    if (findRangeBoundInputs() || pin) {
      return {
        ok: true,
        via: jumped.ok ? "pin-at-frame" : "pin-provisional",
        created: true,
        frame: at,
        range: pin,
        gradeValue: null,
      };
    }
    return { ok: false, error: "create-tail-pin-failed", frame: at, gradeValue: null };
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
    await sleep(W.short);
    const activated = activateStepClass();
    if (!activated) return { ok: false, error: "no-step-class" };
    await sleep(W.panel);

    // Do not set Step Outcome before the pin exists — Outcome radios need an instance.

    const jumped = await goToFrame(at);
    document.activeElement?.blur?.();
    await sleep(W.short);

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
    await waitUntil(
      () =>
        !!findStepTailByGeometry(at, total) ||
        listAllStepRanges(total).some((r) => !before.has(r.el)),
      { timeout: W.create, interval: W.tick }
    );

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
      await waitUntil(() => !!findRangeBoundInputs(), { timeout: W.panel, interval: W.tick });
      pin = findStepTailByGeometry(at, total) || pin;
    }

    if (!pin?.el) {
      return { ok: false, error: "create-step-tail-pin-failed", frame: at };
    }
    return {
      ok: true,
      via: jumped.ok ? "pin-at-frame" : "pin-provisional",
      created: true,
      frame: at,
      range: pin,
    };
  }

  /** Expand Step pin → [start,end] via Fill-at-start/end + lean (full resize last resort). */
  async function expandStepPinToRange(pin, start, end) {
    const total = getTotalFrames();
    if (!pin?.el) return { ok: false, error: "no-step-pin" };

    const refreshStep = () => findStepTailByGeometry(start, total) || pin;

    let wrote = await expandPinToRange(pin, start, end, {
      matchStart: start,
      lockToSelectRange: true,
      selectRange: pin,
      refresh: refreshStep,
    });
    let step = refreshStep() || wrote.range || pin;
    let spanOk =
      step &&
      Math.abs(step.startFrame - start) <= BOUND_EPS &&
      Math.abs(step.endFrame - end) <= BOUND_EPS;

    if (wrote.ok && spanOk) {
      return { ok: true, via: wrote.via || "expand-pin", step };
    }

    wrote = await resizeViaRangeInputs(start, end, {
      matchStart: start,
      selectRange: step || pin,
      lockToSelectRange: true,
    });
    await sleep(W.med);
    step = findStepTailByGeometry(start, total) || step;
    spanOk =
      step &&
      Math.abs(step.startFrame - start) <= BOUND_EPS &&
      Math.abs(step.endFrame - end) <= BOUND_EPS;
    return {
      ok: !!(wrote.ok && spanOk),
      via: wrote.via || "range-inputs",
      step,
      wrote,
    };
  }

  /**
   * After G2 Incomplete is committed: S2 span lastStepEnd+1 → episode end,
   * Step 1 identity + Step Outcome Incomplete, then Done/Esc.
   */
  async function ensureIncompleteStepTail({ tailStart, episodeEnd }) {
    const tAll = nowMs();
    const timing = { createMs: 0, expandMs: 0, outcomeMs: 0, totalMs: 0 };
    const total = getTotalFrames();
    if (episodeEnd == null || tailStart == null || tailStart > episodeEnd) {
      timing.totalMs = msSince(tAll);
      return { ok: true, skipped: true, reason: "no-step-tail-frames", timing };
    }

    function findTailStep() {
      return findStepTailByGeometry(tailStart, total);
    }

    function isReady(s) {
      return (
        s &&
        Math.abs(s.startFrame - tailStart) <= BOUND_EPS &&
        Math.abs(s.endFrame - episodeEnd) <= BOUND_EPS
      );
    }

    let step = findTailStep();
    // Already synced if span is right and Step Outcome Incomplete is checked
    if (isReady(step)) {
      try {
        step.el.click();
      } catch {
        /* ignore */
      }
      await sleep(W.panel);
      if (findStepOutcomeIncompleteChecked().ok) {
        timing.totalMs = msSince(tAll);
        return {
          ok: true,
          skipped: true,
          reason: "step-tail-already-synced",
          step,
          label: "incomplete",
          timing,
        };
      }
    }

    // Create pin at tailStart if missing / wrong start
    if (!step || Math.abs((step.startFrame ?? -1) - tailStart) > 2) {
      const tCreate = nowMs();
      const created = await createStepPinAt(tailStart);
      timing.createMs = msSince(tCreate);
      if (!created.ok) {
        timing.totalMs = msSince(tAll);
        return {
          ok: false,
          error: created.error || "create-step-tail-failed",
          created,
          timing,
        };
      }
      step = findTailStep() || created.range;
      if (!step?.el) {
        timing.totalMs = msSince(tAll);
        return { ok: false, error: "no-step-tail-instance", created, timing };
      }
    }

    // Expand pin → episode end (geometry-backed; do not trust Range inputs alone)
    const tExpand = nowMs();
    let wrote = { ok: false };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      step = findTailStep() || step;
      wrote = await expandStepPinToRange(step, tailStart, episodeEnd);
      await sleep(W.med);
      step = findTailStep() || wrote.step || step;
      if (isReady(step)) break;
    }
    timing.expandMs = msSince(tExpand);

    step = findTailStep() || step;
    if (!isReady(step)) {
      timing.totalMs = msSince(tAll);
      return {
        ok: false,
        error: "step-tail-expand-failed",
        step,
        wrote,
        expected: { start: tailStart, end: episodeEnd },
        timing,
      };
    }

    // Step Outcome → Incomplete (verify radio, not timeline label)
    const tOutcome = nowMs();
    let stepValue = { ok: false };
    for (let i = 0; i < 2; i += 1) {
      step = findTailStep() || step;
      stepValue = await applyIncompleteStepToRange(step);
      await sleep(W.med);
      if (stepValue.ok || findStepOutcomeIncompleteChecked().ok) {
        stepValue = { ...stepValue, ok: true };
        break;
      }
    }
    timing.outcomeMs = msSince(tOutcome);

    await blurRangeFrameInputs();
    await sleep(W.short);

    step = findTailStep() || step;
    const outcomeOk = stepValue.ok || findStepOutcomeIncompleteChecked().ok;
    const ok = isReady(step) && outcomeOk;
    timing.totalMs = msSince(tAll);
    return {
      ok,
      via: wrote.via || "expand+step-outcome-incomplete",
      label: "incomplete",
      startFrame: tailStart,
      endFrame: episodeEnd,
      wrote,
      stepValue,
      step,
      timing,
      error: ok ? undefined : outcomeOk ? "step-tail-bounds" : "step-outcome-incomplete-or-bounds",
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
        Math.abs(tailGrade.startFrame - tailStart) <= BOUND_EPS &&
        Math.abs(tailGrade.endFrame - episodeEnd) <= BOUND_EPS);
    const stepTailOk =
      !hasTail ||
      (stepTail &&
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

    function toastWaiting(wantStep) {
      if (quiet) return;
      const msg =
        wantStep != null && Number.isFinite(Number(wantStep))
          ? `Waiting for Step ${wantStep}`
          : "Waiting for Step list";
      lastToastKey = msg;
      showToast(msg, "info");
    }

    // Auto path: require ontology last Step id, and that it exists on the timeline.
    if (!force) {
      const defined = await ensureDefinedLastStep();
      if (!defined?.lastStepNum) {
        toastWaiting(null);
        return { ok: false, skipped: true, reason: "no-defined-steps" };
      }
      const onTimeline = findStepRangeByNum(defined.lastStepNum);
      if (!onTimeline) {
        toastWaiting(defined.lastStepNum);
        return {
          ok: false,
          skipped: true,
          reason: "waiting-for-last-defined-step",
          wantStep: defined.lastStepNum,
          timelineMax: findLastTimelineStepRange()?.stepNum ?? null,
        };
      }
    } else {
      // Manual Annotate now: refresh defined steps so target prefers ontology last if present
      const defined = await ensureDefinedLastStep();
      if (!defined?.lastStepNum) {
        toastWaiting(null);
        return { ok: false, skipped: true, reason: "no-defined-steps", defined };
      }
      if (!findStepRangeByNum(defined.lastStepNum)) {
        toastWaiting(defined.lastStepNum);
        return {
          ok: false,
          skipped: true,
          reason: "waiting-for-last-defined-step",
          wantStep: defined.lastStepNum,
          timelineMax: findLastTimelineStepRange()?.stepNum ?? null,
        };
      }
    }

    const snap = snapshot();
    if (!snap.ready) {
      if (
        snap.reason === "last-defined-step-not-on-timeline" ||
        snap.reason === "no-last-step" ||
        snap.reason === "no-defined-steps"
      ) {
        toastWaiting(snap.definedSteps?.lastStepNum ?? null);
      }
      return { ok: false, skipped: true, reason: snap.reason, snap };
    }
    if (!snap.needsSync && !force) {
      return { ok: true, skipped: true, reason: "already-synced", snap };
    }

    syncing = true;
    if (!quiet) showProgress("Annotating");
    const tSync = nowMs();
    const timing = {
      focusMs: 0,
      ensureMs: 0,
      ensureVia: null,
      g1Ms: 0,
      g1Via: null,
      g1RetryMs: 0,
      g2CreateMs: 0,
      g2ResizeMs: 0,
      g2Via: null,
      g1RestoreMs: 0,
      g1RestoreVia: null,
      g2RecheckMs: 0,
      g2IncompleteMs: 0,
      s2Ms: 0,
      s2CreateMs: 0,
      s2ExpandMs: 0,
      s2OutcomeMs: 0,
      s2Via: null,
      handoffMs: 0,
      totalMs: 0,
    };
    try {
      // Details panel steals focus — wait until the editor is focused before creating Grade.
      let tPhase = nowMs();
      await waitForPageFocus(force ? 2500 : 800);
      timing.focusMs = msSince(tPhase);

      // Absolute bounds only — never derive start from playhead / currentFrame
      const endFrame = snap.target.endFrame;

      tPhase = nowMs();
      const ensured = await ensureTrajectoryInstance();
      timing.ensureMs = msSince(tPhase);
      timing.ensureVia = ensured.via || null;
      if (!ensured.ok) {
        timing.totalMs = msSince(tSync);
        logSyncTiming(timing, false);
        if (!quiet) {
          const msg = "Could not open/create trajectory for Grade sync.";
          lastToastKey = msg;
          showToast(msg, "warn");
        }
        return { ok: false, error: ensured.error || "ensure-failed", ensured, snap, timing };
      }

      tPhase = nowMs();
      const wrote = await resizeRangeSmart(0, endFrame, { matchStart: 0 });
      timing.g1Ms = msSince(tPhase);
      timing.g1Via = wrote.path || wrote.via || null;
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
          tPhase = nowMs();
          const retry = await resizeRangeSmart(0, endFrame, { matchStart: 0 });
          timing.g1RetryMs = msSince(tPhase);
          const afterRetry = snapshot();
          const retryOk =
            retry.ok &&
            afterRetry.grade &&
            Math.abs((afterRetry.grade.startFrame ?? -1) - 0) <= BOUND_EPS &&
            Math.abs((afterRetry.grade.endFrame ?? -1) - endFrame) <= BOUND_EPS;
          if (!retryOk) {
            timing.totalMs = msSince(tSync);
            logSyncTiming(timing, false);
            return {
              ok: false,
              error: endIsPlayhead ? "end-is-playhead" : "bounds-mismatch",
              wrote,
              retry,
              snap: afterRetry,
              playhead,
              wantEnd: endFrame,
              timing,
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
          tPhase = nowMs();
          let fixShort = await quickRestorePrimaryEnd(endFrame);
          if (!fixShort.ok) {
            fixShort = await resizeRangeSmart(0, endFrame, { matchStart: 0 });
          }
          timing.g1RetryMs += msSince(tPhase);
          primaryGeo = findPrimaryGradeRange();
          primaryEnd = primaryGeo?.endFrame ?? primaryEnd;
          if (!fixShort.ok || primaryEnd < endFrame) {
            timing.totalMs = msSince(tSync);
            logSyncTiming(timing, false);
            return {
              ok: false,
              error: "primary-end-short",
              wrote,
              fixShort,
              wantEnd: endFrame,
              primaryEnd,
              snap: snapshot(),
              timing,
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
            Math.abs(tail.startFrame - tailStart) <= BOUND_EPS &&
            Math.abs(tail.endFrame - episodeEnd) <= BOUND_EPS;
          if (!tailReady) {
            if (!tail || Math.abs((tail.startFrame ?? -1) - tailStart) > 2) {
              // Create far from G1's end so Encord doesn't auto-trim the abutting edge.
              const pinAt = episodeEnd;
              tPhase = nowMs();
              const createdTail = await createGradePinAt(pinAt);
              timing.g2CreateMs = msSince(tPhase);
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
              tPhase = nowMs();
              wroteTail = await resizeRangeSmart(tailStart, episodeEnd, {
                matchStart: Math.max(tailStart, tail.startFrame || tailStart),
                selectRange: tail,
                lockToSelectRange: true,
              });
              timing.g2ResizeMs = msSince(tPhase);
              timing.g2Via = wroteTail.path || wroteTail.via || null;
            } else if (wroteTail.ok !== false && !tail) {
              wroteTail = { ok: false, error: "no-tail-instance" };
            }
          } else {
            wroteTail = { ok: true, skipped: true, reason: "tail-already-synced" };
          }

          // Re-assert G1 after G2 — only if exact bounds broken (Fill-at-start used to trim by 1).
          primaryGeo = findPrimaryGradeRange();
          if (
            primaryGeo &&
            Math.abs((primaryGeo.endFrame ?? -1) - endFrame) <= BOUND_EPS &&
            Math.abs((primaryGeo.startFrame ?? -1) - 0) <= BOUND_EPS
          ) {
            timing.g1RestoreVia = "unneeded";
          } else {
            tPhase = nowMs();
            let restorePrimary = await quickRestorePrimaryEnd(endFrame);
            if (!restorePrimary.ok) {
              restorePrimary = await resizeRangeSmart(0, endFrame, { matchStart: 0 });
            }
            timing.g1RestoreMs = msSince(tPhase);
            timing.g1RestoreVia = restorePrimary.via || restorePrimary.path || null;
            primaryGeo = findPrimaryGradeRange();
            if (
              !restorePrimary.ok ||
              Math.abs((primaryGeo?.endFrame ?? -1) - endFrame) > BOUND_EPS ||
              Math.abs((primaryGeo?.startFrame ?? -1) - 0) > BOUND_EPS
            ) {
              timing.totalMs = msSince(tSync);
              logSyncTiming(timing, false);
              return {
                ok: false,
                error: "primary-trimmed-by-tail",
                wrote,
                wroteTail,
                restorePrimary,
                wantEnd: endFrame,
                primaryEnd: primaryGeo?.endFrame,
                snap: snapshot(),
                timing,
              };
            }
          }

          // G2 recheck — geometry first; no settle sleep when already exact.
          tPhase = nowMs();
          let tailAfter = findGradeNearStart(tailStart, total);
          if (tailAfter && tailAfter.startFrame > 1) {
            const startOk = Math.abs(tailAfter.startFrame - tailStart) <= BOUND_EPS;
            let endOk = Math.abs((tailAfter.endFrame ?? -1) - episodeEnd) <= BOUND_EPS;
            if (!(startOk && endOk)) {
              if (!endOk) {
                try {
                  tailAfter.el.click();
                  await sleep(W.short);
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
                wroteTail = await resizeRangeSmart(tailStart, episodeEnd, {
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
              if (wroteTail.ok !== false && tailAfter) {
                let stillShort =
                  Math.abs((tailAfter.endFrame ?? -1) - episodeEnd) > BOUND_EPS;
                if (stillShort) {
                  try {
                    tailAfter.el.click();
                    await sleep(W.short);
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
          }
          timing.g2RecheckMs = msSince(tPhase);

          // G2 Incomplete: after bounds are final → I → Done/Esc.
          const tailForValue =
            findGradeNearStart(tailStart, total) || tailAfter || tail;
          let gradeValue = null;
          if (wroteTail.ok !== false && tailForValue?.el) {
            tPhase = nowMs();
            gradeValue = await applyIncompleteGradeToRange(tailForValue);
            timing.g2IncompleteMs = msSince(tPhase);
            wroteTail = { ...wroteTail, gradeValue };
            await sleep(W.short);
          }
          primaryEnd = findPrimaryGradeRange()?.endFrame ?? endFrame;

          // S2: same span as G2 → Step 1 + Step Outcome Incomplete → Done/Esc
          if (wroteTail.ok !== false) {
            tPhase = nowMs();
            wroteStepTail = await ensureIncompleteStepTail({ tailStart, episodeEnd });
            timing.s2Ms = msSince(tPhase);
            if (wroteStepTail?.timing) {
              timing.s2CreateMs = wroteStepTail.timing.createMs || 0;
              timing.s2ExpandMs = wroteStepTail.timing.expandMs || 0;
              timing.s2OutcomeMs = wroteStepTail.timing.outcomeMs || 0;
            }
            timing.s2Via = wroteStepTail?.via || wroteStepTail?.wrote?.via || null;
          } else {
            wroteStepTail = { ok: false, skipped: true, reason: "g2-failed" };
          }
        }

        // Hand focus to G1 only (never G2)
        let gradeHandoff = null;
        if (wroteTail.ok !== false && wroteStepTail.ok !== false) {
          tPhase = nowMs();
          gradeHandoff = await selectGradeForOperator();
          timing.handoffMs = msSince(tPhase);
        }

        const after = snapshot();
        lastAppliedKey = snap.key;
        await blurRangeFrameInputs();
        await sleep(W.short);
        timing.totalMs = msSince(tSync);
        const syncOk = wroteTail.ok !== false && wroteStepTail.ok !== false;
        logSyncTiming(timing, syncOk);
        if (!quiet) {
          const msg = syncOk ? "Annotation complete" : "Annotation incomplete";
          lastToastKey = msg;
          showToast(msg, syncOk ? "ok" : "warn");
        }
        return {
          ok: syncOk,
          method: "ensure+range-inputs+tail",
          snap: after,
          ensured,
          wrote,
          wroteTail,
          wroteStepTail,
          gradeHandoff,
          primaryEnd,
          timing,
          error:
            wroteTail.ok === false
              ? wroteTail.error
              : wroteStepTail.ok === false
                ? wroteStepTail.error
                : undefined,
        };
      }

      timing.totalMs = msSince(tSync);
      logSyncTiming(timing, false);
      if (!quiet) {
        const msg =
          wrote.error === "cannot-set-timeline-range"
            ? `Could not commit Grade on the timeline (${wrote.timeline?.startFrame ?? "?"}–${wrote.timeline?.endFrame ?? "?"} vs 0–${endFrame}).`
            : `Could not set Range start/end (${wrote.error || "failed"}).`;
        lastToastKey = msg;
        showToast(msg, "warn");
      }
      return { ok: false, error: wrote.error || "range-inputs-failed", ensured, wrote, snap, timing };
    } catch (err) {
      timing.totalMs = msSince(tSync);
      logSyncTiming(timing, false);
      if (!quiet) {
        showToast(err?.message || "Annotation failed.", "warn");
      }
      return { ok: false, error: err?.message || String(err), snap, timing };
    } finally {
      syncing = false;
      // If a failure path skipped showToast, clear the in-progress chip
      if (!quiet) dismissProgress();
    }
  }

  /**
   * Auto annotation: Esc/Done → full sync once per episode when last defined Step is present.
   * Further last-Step edits do not re-run. Manual Annotate now (force:true) bypasses this.
   */
  function scheduleWorkflowSync() {
    if (!enabled || syncing) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      (async () => {
        resetAutoAnnotateIfEpisodeChanged();
        if (autoAnnotatedOnce) return;
        const defined = await ensureDefinedLastStep();
        if (!defined?.lastStepNum) return;
        if (!findStepRangeByNum(defined.lastStepNum)) return;
        const snap = snapshot();
        if (!snap.ready) return;
        const result = await syncGrade({ quiet: false });
        // Lock only after a real successful auto pass (not skip/fail)
        if (result?.ok && !result?.skipped) {
          autoAnnotatedOnce = true;
          autoAnnotatedEpisodeKey = getEpisodeKey();
        }
      })().catch(() => {});
    }, WORKFLOW_DEBOUNCE_MS);
  }

  /** Resize/drag no longer auto-annotates — Esc/Done one-shot is the only auto path. */
  function scheduleLastStepResizeSync() {
    /* intentionally no-op */
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
      else enabled = false; // off by default — opt in via popup
    } catch {
      enabled = false;
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
      enabled = changes[STORAGE_ENABLED].newValue === true;
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
      enabled = message.enabled === true;
      chrome.storage.local.set({ [STORAGE_ENABLED]: enabled }).then(() => {
        sendResponse({ ok: true, enabled });
        // Do not sync on toggle — wait for Esc/Done after last defined Step
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
