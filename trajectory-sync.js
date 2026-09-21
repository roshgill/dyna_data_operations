// Auto-sync Trajectory → Grade to 0 → end of last Step.
// Write path: Encord classification UI (frame jump + C/V/M or Range start/end inputs).
// No timeline draw-drag / alt-click / shift-click (those create single-frame pins).
(() => {
  const VERSION = "0.14.4-grade";
  const STORAGE_ENABLED = "autoGradeEnabled";
  const PCT_EPS = 0.4;
  const FRAME_EPS = 1;
  const WORKFLOW_DEBOUNCE_MS = 550;

  if (window.__encordGradeSync?.version === VERSION) return;

  let enabled = true;
  let syncing = false;
  let debounceTimer = null;
  let lastToastKey = "";
  let lastAppliedKey = "";

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

  function listRanges(rowTestId, opts) {
    const row = document.querySelector(`[data-testid="${rowTestId}"]`);
    if (!row) return [];
    return [...row.querySelectorAll('[data-testid="range"]')]
      .map((el) => describeRange(el, opts))
      .filter(Boolean);
  }

  function parseStepNumber(label) {
    const m = String(label || "").match(/^step\s*(\d+)\b/i);
    return m ? Number(m[1]) : null;
  }

  function findLastStepRange() {
    const steps = listRanges("row-step", { includePins: false })
      .map((r) => ({ ...r, stepNum: parseStepNumber(r.label) }))
      .filter((r) => r.stepNum != null && r.width >= 0.35);
    if (!steps.length) return null;
    const maxN = Math.max(...steps.map((s) => s.stepNum));
    const candidates = steps.filter((s) => s.stepNum === maxN);
    candidates.sort((a, b) => b.width - a.width || b.end - a.end);
    return candidates[0];
  }

  function isGradeLabel(label) {
    const t = normalizeLabel(label).toLowerCase();
    return !t || t === "grade" || /^grade\b/.test(t);
  }

  /** Prefer a real span; fall back to pin (1-frame) grade markers. */
  function findPrimaryGradeRange() {
    const all = listRanges("row-trajectory").filter((r) => isGradeLabel(r.label));
    if (!all.length) {
      const any = listRanges("row-trajectory");
      if (!any.length) return null;
      any.sort((a, b) => b.width - a.width);
      return any[0];
    }
    const spans = all.filter((r) => !r.pin && r.width >= 0.35);
    if (spans.length) {
      spans.sort((a, b) => b.width - a.width);
      return spans[0];
    }
    all.sort((a, b) => b.width - a.width || b.left - a.left);
    return all[0];
  }

  function listGradeRanges() {
    return listRanges("row-trajectory").filter((r) => isGradeLabel(r.label));
  }

  function pctToFrame(pct, totalFrames) {
    return Math.max(0, Math.min(totalFrames, Math.round((pct / 100) * totalFrames)));
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

  /**
   * Deselect instances via UI clicks. Synthetic Escape is often ignored
   * (isTrusted=false), which leads to "Cannot change class…".
   */
  async function clearInstanceSelection() {
    const click = (el) => {
      if (!el) return false;
      try {
        el.click();
        return true;
      } catch {
        return false;
      }
    };

    // Camera tile / mode chrome — leaves classification instance selection
    click(document.querySelector('[data-testid="tile-display-name"]'));
    await sleep(40);
    click(document.querySelector('[data-testid="editor-mode-status-tag"]'));
    await sleep(40);

    const canvas =
      document.querySelector('[data-testid="canvas"]') ||
      document.querySelector('[data-testid="editor-content"]');
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

  function timelineBounds() {
    const grade = findPrimaryGradeRange();
    const total = getTotalFrames();
    if (!grade || !total) return null;
    return {
      startFrame: pctToFrame(grade.left, total),
      endFrame: pctToFrame(grade.end, total),
      span: pctToFrame(grade.width, total),
      total,
    };
  }

  function timelineMatches(wantStart, wantEnd) {
    const t = timelineBounds();
    if (!t) return false;
    return (
      Math.abs(t.startFrame - wantStart) <= FRAME_EPS + 1 &&
      Math.abs(t.endFrame - wantEnd) <= FRAME_EPS + 1
    );
  }

  /**
   * Commit real timeline geometry. Zero-width pins ignore Range inputs (fields can
   * show 0–810 while the bar stays 827–827). Order:
   * 1) Fill-to-playhead at 0 and at wantEnd (creates a real span)
   * 2) Range inputs for exact values
   * 3) ⌥-arrow Adjust left/right to nudge remaining error
   * Success requires the timeline bar to match — never inputs-only.
   */
  async function resizeViaRangeInputs(_startFrame, endFrame) {
    const wantStart = 0;
    const liveStep = findLastStepRange();
    const totalLive = getTotalFrames();
    let wantEnd = Math.max(
      wantStart,
      Math.floor(liveStep && totalLive ? pctToFrame(liveStep.end, totalLive) : endFrame)
    );
    if (totalLive) {
      wantEnd = Math.min(wantEnd, Math.max(0, totalLive - 1));
    }

    async function selectGrade() {
      const grade = findPrimaryGradeRange();
      if (!grade) return false;
      try {
        grade.el.click();
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
      await selectGrade();
      const via = jumped.ok ? clickFillToPlayhead() : null;
      await sleep(240);
      return { jumped: jumped.ok, via, geo: timelineBounds() };
    }

    if (!(await selectGrade()) && !findRangeBoundInputs()) {
      return { ok: false, error: "no-grade" };
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await selectGrade();
      let geo = timelineBounds();

      // 1) Expand pin → real range via Fill (inputs alone do not grow a pin)
      if (!geo || geo.span <= 2 || Math.abs(geo.startFrame - wantStart) > FRAME_EPS + 1) {
        await fillAt(wantStart);
        geo = timelineBounds();
      }
      if (!geo || geo.endFrame < wantEnd - 1) {
        await fillAt(wantEnd);
        geo = timelineBounds();
      }
      // If still a pin past wantEnd (e.g. 827), Fill at 0 then at wantEnd
      if (geo && geo.span <= 2) {
        await fillAt(wantStart);
        await fillAt(wantEnd);
        geo = timelineBounds();
      }

      // 2) Exact values via Range inputs (works once a real span exists)
      const written = await writeInputs(wantStart, wantEnd);
      await sleep(150);
      geo = timelineBounds();

      // 3) Nudge with Adjust left/right (⌥←/→, ⌥⇧←/→) if still off
      if (geo && !timelineMatches(wantStart, wantEnd)) {
        await selectGrade();
        const startDelta = wantStart - geo.startFrame;
        const endDelta = wantEnd - geo.endFrame;
        // Cap steps so we don't spin forever on a stuck control
        if (Math.abs(startDelta) > 0 && Math.abs(startDelta) <= 40) {
          adjustLeftSide(startDelta);
          await sleep(120);
        }
        if (Math.abs(endDelta) > 0 && Math.abs(endDelta) <= 40) {
          adjustRightSide(endDelta);
          await sleep(120);
        }
        geo = timelineBounds();
        // Re-type after nudge
        if (!timelineMatches(wantStart, wantEnd)) {
          await writeInputs(wantStart, wantEnd);
          await sleep(120);
        }
      }

      // 4) Last resort: if end still high, Fill can't shrink — keep Adjust end down
      geo = timelineBounds();
      if (geo && geo.endFrame > wantEnd + 1 && geo.endFrame - wantEnd <= 60) {
        await selectGrade();
        adjustRightSide(wantEnd - geo.endFrame);
        await sleep(150);
        await writeInputs(wantStart, wantEnd);
        await sleep(100);
      }

      if (timelineMatches(wantStart, wantEnd)) {
        clickDoneIfPresent();
        await sleep(280);
        if (timelineMatches(wantStart, wantEnd)) {
          return {
            ok: true,
            via: "fill+inputs+adjust+timeline",
            after: timelineBounds(),
            want: { startFrame: wantStart, endFrame: wantEnd },
            written,
            attempts: attempt + 1,
          };
        }
      }
    }

    const t = timelineBounds();
    const inputs = findRangeBoundInputs();
    return {
      ok: false,
      error: "cannot-set-timeline-range",
      message:
        "Frame fields may show the right numbers, but the timeline annotation did not move to 0–last step end.",
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
      const row = document.querySelector('[data-testid="row-trajectory"]');
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

  function snapshot() {
    const totalFrames = getTotalFrames();
    const lastStep = findLastStepRange();
    const grade = findPrimaryGradeRange();
    if (!totalFrames || !lastStep) {
      return {
        ready: false,
        reason: !totalFrames ? "no-frames" : "no-last-step",
        totalFrames,
        lastStep: null,
        grade: null,
      };
    }
    const targetEndPct = lastStep.end;
    const targetEndFrame = pctToFrame(targetEndPct, totalFrames);
    const gradeEndFrame = grade ? pctToFrame(grade.end, totalFrames) : null;
    const gradeStartFrame = grade ? pctToFrame(grade.left, totalFrames) : null;
    const gradeSpan =
      grade && gradeEndFrame != null && gradeStartFrame != null ? gradeEndFrame - gradeStartFrame : 0;
    const needsSync =
      !grade ||
      gradeSpan <= 2 ||
      Math.abs((gradeStartFrame ?? -1) - 0) > FRAME_EPS ||
      Math.abs((gradeEndFrame ?? -1) - targetEndFrame) > FRAME_EPS;

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
      target: { startFrame: 0, endFrame: targetEndFrame, startPct: 0, endPct: targetEndPct },
      needsSync,
      gradeCount: listGradeRanges().length,
      key: `step${lastStep.stepNum}:${targetEndFrame}:${totalFrames}`,
    };
  }

  async function syncGrade({ force = false, quiet = false } = {}) {
    if (!enabled && !force) return { ok: false, skipped: true, reason: "disabled" };
    if (syncing) return { ok: false, skipped: true, reason: "busy" };
    if (!location.pathname.includes("/label_editor/")) {
      return { ok: false, skipped: true, reason: "not-editor" };
    }

    const snap = snapshot();
    if (!snap.ready) return { ok: false, skipped: true, reason: snap.reason, snap };
    if (!snap.needsSync && !force) {
      return { ok: true, skipped: true, reason: "already-synced", snap };
    }

    syncing = true;
    try {
      // Absolute bounds only — never derive start from playhead / currentFrame
      const startFrame = 0;
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

      const wrote = await resizeViaRangeInputs(startFrame, endFrame);
      if (wrote.ok) {
        // Final guard: start must be 0 and end must be last-step (not playhead)
        const check = snapshot();
        const playhead = getCurrentFrame();
        const endOk =
          check.grade &&
          Math.abs((check.grade.endFrame ?? -1) - endFrame) <= FRAME_EPS + 1;
        const startOk = check.grade && Math.abs((check.grade.startFrame ?? -1) - 0) <= FRAME_EPS;
        const endIsPlayhead =
          playhead != null &&
          check.grade &&
          Math.abs((check.grade.endFrame ?? -1) - playhead) <= FRAME_EPS &&
          Math.abs(endFrame - playhead) > FRAME_EPS;

        if (!startOk || !endOk || endIsPlayhead) {
          const retry = await resizeViaRangeInputs(0, endFrame);
          const afterRetry = snapshot();
          const retryOk =
            retry.ok &&
            afterRetry.grade &&
            Math.abs((afterRetry.grade.startFrame ?? -1) - 0) <= FRAME_EPS &&
            Math.abs((afterRetry.grade.endFrame ?? -1) - endFrame) <= FRAME_EPS + 1;
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
        const after = snapshot();
        lastAppliedKey = snap.key;
        if (!quiet) {
          const msg = ensured.created
            ? `Grade created 0–${endFrame} (step ${snap.lastStep.stepNum})`
            : `Grade set to 0–${endFrame} (step ${snap.lastStep.stepNum})`;
          if (lastToastKey !== msg) {
            lastToastKey = msg;
            showToast(msg, "ok");
          }
        }
        return { ok: true, method: "ensure+range-inputs", snap: after, ensured, wrote };
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

  /** After Step edit → Escape/Done, fit Grade (workflow trigger). */
  function scheduleWorkflowSync() {
    if (!enabled || syncing) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      syncGrade({ quiet: false }).catch(() => {});
    }, WORKFLOW_DEBOUNCE_MS);
  }

  async function loadEnabled() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_ENABLED);
      if (typeof stored[STORAGE_ENABLED] === "boolean") enabled = stored[STORAGE_ENABLED];
      else enabled = true; // on by default — Escape/Done after last Step
    } catch {
      enabled = true;
    }
  }

  function startWatch() {
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
      loadEnabled().then(() => {
        sendResponse({
          ok: true,
          version: VERSION,
          enabled,
          snapshot: snapshot(),
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
    return false;
  });

  window.__encordGradeSync = {
    version: VERSION,
    snapshot,
    syncGrade,
  };

  loadEnabled().then(startWatch);
})();
