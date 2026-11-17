// Quick reason chips:
// 1) Under Skip task textarea → fill reason
// 2) Under Metadata "Data title" → pathway + reason with copy
(() => {
  const VERSION = "0.18.76-skip-chips";
  const STORAGE_ENABLED = "skipReasonChipsEnabled";
  const SKIP_ROW_ID = "dyna-skip-reason-chips";
  const META_WRAP_ID = "dyna-meta-reason-wrap";
  const META_HINT_ID = "dyna-meta-reason-hint";
  const META_ROW_ID = "dyna-meta-reason-chips";
  const META_COPY_ID = "dyna-meta-reason-copy";
  const META_PLACEHOLDER = "[select reason]";
  const REASONS = [
    "wrong dataset",
    "no complete step",
    "accident",
    "missing frames",
    "old fold",
  ];
  const LOG = "[dyna-skip-chips]";

  if (window.__encordSkipReasonChips?.version === VERSION) return;

  /** Default on when unset */
  let enabled = true;
  /** @type {string | null} */
  let metaSelectedReason = null;
  /** @type {string | null} */
  let lastAutoCopiedValue = null;

  async function loadEnabled() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_ENABLED);
      enabled = stored[STORAGE_ENABLED] !== false;
    } catch {
      enabled = true;
    }
    log("enabled=", enabled);
  }

  function tearDownChips() {
    document.getElementById(SKIP_ROW_ID)?.remove();
    document.getElementById(META_WRAP_ID)?.remove();
  }

  function setEnabled(next) {
    enabled = next !== false;
    if (!enabled) {
      tearDownChips();
      metaSelectedReason = null;
      lastAutoCopiedValue = null;
    } else {
      scheduleEnsure();
    }
    log("setEnabled", enabled);
  }

  function log(...args) {
    try {
      console.log(LOG, ...args);
    } catch {
      /* ignore */
    }
  }

  function normalize(raw) {
    return String(raw || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function visible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function styleRow(row) {
    Object.assign(row.style, {
      display: "flex",
      flexWrap: "wrap",
      gap: "6px",
      marginTop: "8px",
      marginBottom: "4px",
    });
  }

  function styleChip(chip, selected) {
    Object.assign(chip.style, {
      appearance: "none",
      margin: "0",
      cursor: "pointer",
      borderRadius: "999px",
      border: selected ? "1px solid rgba(26, 26, 26, 0.35)" : "1px solid rgba(26, 26, 26, 0.14)",
      background: selected ? "#1a1a1a" : "#f2f0e9",
      color: selected ? "#f2f0e9" : "#1a1a1a",
      font: '11px/1.2 "Avenir Next", "Segoe UI", "Helvetica Neue", Helvetica, sans-serif',
      padding: "5px 10px",
      whiteSpace: "nowrap",
    });
  }

  function syncChipRow(row, selectedReason) {
    const current = normalize(selectedReason);
    for (const chip of row.querySelectorAll("button[data-dyna-skip-reason]")) {
      const selected = normalize(chip.dataset.dynaSkipReason) === current && current.length > 0;
      chip.setAttribute("aria-pressed", selected ? "true" : "false");
      styleChip(chip, selected);
    }
  }

  function makeChipRow(rowId, onSelect) {
    const row = document.createElement("div");
    row.id = rowId;
    row.dataset.dynaSkipChips = "1";
    styleRow(row);

    for (const reason of REASONS) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.dataset.dynaSkipReason = reason;
      chip.textContent = reason;
      chip.setAttribute("aria-pressed", "false");
      styleChip(chip, false);
      chip.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onSelect(reason, chip);
      });
      row.appendChild(chip);
    }
    return row;
  }

  // --- Skip dialog ---

  function findSkipTaskButton() {
    return [...document.querySelectorAll("button")].find((btn) =>
      /skip\s*task/i.test((btn.textContent || "").replace(/\s+/g, " ").trim())
    );
  }

  function findSkipTextarea() {
    const skipBtn = findSkipTaskButton();
    if (!skipBtn) return null;

    let root = skipBtn.parentElement;
    for (let i = 0; i < 10 && root; i++) {
      const areas = [...root.querySelectorAll("textarea")].filter(visible);
      if (areas.length === 1) return areas[0];
      if (areas.length > 1) {
        let best = areas[0];
        let bestDist = Infinity;
        const btnRect = skipBtn.getBoundingClientRect();
        for (const ta of areas) {
          const r = ta.getBoundingClientRect();
          const dist = Math.abs(r.bottom - btnRect.top) + Math.abs(r.left - btnRect.left);
          if (dist < bestDist) {
            best = ta;
            bestDist = dist;
          }
        }
        return best;
      }
      root = root.parentElement;
    }
    return null;
  }

  function setTextareaValue(textarea, value) {
    const proto = window.HTMLTextAreaElement?.prototype;
    const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(textarea, value);
    else textarea.value = value;

    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function applySkipReason(reason) {
    const next = reason || "";
    const textarea = findSkipTextarea();
    if (!textarea) return false;
    // Avoid re-entrant ensure while building the skip row.
    const row = document.getElementById(SKIP_ROW_ID);
    setTextareaValue(textarea, next);
    if (row) syncChipRow(row, textarea.value);
    return true;
  }

  function ensureSkipChips() {
    const textarea = findSkipTextarea();
    if (!textarea) {
      document.getElementById(SKIP_ROW_ID)?.remove();
      return false;
    }

    // If meta already chose a reason and Skip is empty, mirror it in.
    if (metaSelectedReason && !normalize(textarea.value)) {
      setTextareaValue(textarea, metaSelectedReason);
    }

    const existing = document.getElementById(SKIP_ROW_ID);
    if (existing && existing.previousElementSibling === textarea) {
      syncChipRow(existing, textarea.value);
      return true;
    }

    existing?.remove();
    const row = makeChipRow(SKIP_ROW_ID, (reason) => {
      const already = normalize(textarea.value) === normalize(reason);
      setTextareaValue(textarea, already ? "" : reason);
      syncChipRow(row, textarea.value);
      try {
        textarea.focus();
      } catch {
        /* ignore */
      }
    });
    textarea.insertAdjacentElement("afterend", row);
    syncChipRow(row, textarea.value);

    if (!textarea.dataset.dynaSkipChipsBound) {
      textarea.dataset.dynaSkipChipsBound = "1";
      textarea.addEventListener("input", () => {
        const live = document.getElementById(SKIP_ROW_ID);
        if (live) syncChipRow(live, textarea.value);
      });
    }

    log("injected under skip textarea");
    return true;
  }

  // --- Metadata panel ---

  function findDataTitleGroup() {
    const section =
      document.querySelector('section[aria-label="Data details"]') ||
      [...document.querySelectorAll("section")].find((el) =>
        /data\s*details/i.test(el.getAttribute("aria-label") || "")
      );
    if (!section || !visible(section)) return null;

    for (const group of section.children) {
      if (!(group instanceof HTMLElement)) continue;
      const label = [...group.querySelectorAll("span")].find((span) =>
        /^data\s*title$/i.test((span.textContent || "").trim())
      );
      if (label) return group;
    }
    return null;
  }

  function readPathway(group) {
    if (!group) return "";
    // Value sits in a wrap-break-word div under the label row.
    const valueEl =
      group.querySelector(".wrap-break-word, [class*='wrap-break-word'], [class*='whitespace-pre-wrap']") ||
      [...group.querySelectorAll("div")].find((div) => {
        const text = (div.textContent || "").trim();
        if (!text || /^data\s*title$/i.test(text)) return false;
        if (div.querySelector("span.anticon, [role='img']")) return false;
        return text.includes("/") || /episode/i.test(text);
      });
    return String(valueEl?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function styleCopyField(field, ready) {
    Object.assign(field.style, {
      display: "block",
      marginTop: "8px",
      padding: "8px 10px",
      borderRadius: "8px",
      border: "1px solid rgba(26, 26, 26, 0.14)",
      background: "#f2f0e9",
      cursor: ready ? "pointer" : "default",
      font: '11px/1.35 "Avenir Next", "Segoe UI", "Helvetica Neue", Helvetica, sans-serif',
      color: ready ? "#1a1a1a" : "rgba(26, 26, 26, 0.45)",
      wordBreak: "break-word",
      userSelect: "none",
    });
  }

  function composeMetaValue(pathway, reason) {
    if (!pathway) return "";
    return reason ? `${pathway} ${reason}` : `${pathway} ${META_PLACEHOLDER}`;
  }

  async function copyMetaValue(field, value, { flash = true } = {}) {
    if (!value || value.endsWith(` ${META_PLACEHOLDER}`)) return false;
    try {
      await navigator.clipboard.writeText(value);
      lastAutoCopiedValue = value;
      if (flash) {
        field.textContent = "Copied";
        setTimeout(() => {
          if (field.isConnected) field.textContent = value;
        }, 1200);
      }
      return true;
    } catch {
      if (flash) {
        field.textContent = "Copy failed";
        setTimeout(() => {
          if (field.isConnected) field.textContent = value;
        }, 1200);
      }
      return false;
    }
  }

  function updateMetaCopyField(wrap, pathway, reason, { autoCopy = false } = {}) {
    let field = document.getElementById(META_COPY_ID);
    if (!pathway) {
      field?.remove();
      return;
    }

    const composed = composeMetaValue(pathway, reason);
    const ready = Boolean(reason);

    if (!field) {
      field = document.createElement("div");
      field.id = META_COPY_ID;
      field.dataset.dynaMetaCopy = "1";
      field.setAttribute("role", "button");
      field.setAttribute("tabindex", "0");
      field.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const value = field.dataset.dynaMetaCopyValue || "";
        if (!value || value.endsWith(` ${META_PLACEHOLDER}`)) return;
        copyMetaValue(field, value);
      });
      field.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        const value = field.dataset.dynaMetaCopyValue || "";
        if (!value || value.endsWith(` ${META_PLACEHOLDER}`)) return;
        copyMetaValue(field, value);
      });
      wrap.appendChild(field);
    }

    styleCopyField(field, ready);
    field.dataset.dynaMetaCopyValue = composed;
    field.title = ready ? "Click to copy" : "Select a reason to copy";
    if (field.textContent !== "Copied" && field.textContent !== "Copy failed") {
      field.textContent = composed;
    }

    if (autoCopy && ready && composed !== lastAutoCopiedValue) {
      copyMetaValue(field, composed);
    }
    if (!ready) lastAutoCopiedValue = null;
  }

  function ensureMetaChips() {
    const group = findDataTitleGroup();
    if (!group) {
      document.getElementById(META_WRAP_ID)?.remove();
      metaSelectedReason = null;
      lastAutoCopiedValue = null;
      return false;
    }

    const pathway = readPathway(group);
    let wrap = document.getElementById(META_WRAP_ID);
    if (!wrap || wrap.previousElementSibling !== group) {
      wrap?.remove();
      lastAutoCopiedValue = null;
      wrap = document.createElement("div");
      wrap.id = META_WRAP_ID;
      wrap.dataset.dynaMetaReasonWrap = "1";
      Object.assign(wrap.style, {
        marginTop: "4px",
        marginBottom: "4px",
      });

      const hint = document.createElement("p");
      hint.id = META_HINT_ID;
      hint.textContent = "Select episode issue and paste into Slack";
      Object.assign(hint.style, {
        margin: "0 0 6px",
        font: '11px/1.35 "Avenir Next", "Segoe UI", "Helvetica Neue", Helvetica, sans-serif',
        color: "#f2f0e9",
      });
      wrap.appendChild(hint);

      const row = makeChipRow(META_ROW_ID, (reason) => {
        metaSelectedReason = normalize(metaSelectedReason) === normalize(reason) ? null : reason;
        syncChipRow(row, metaSelectedReason);
        updateMetaCopyField(wrap, readPathway(group), metaSelectedReason, {
          autoCopy: Boolean(metaSelectedReason),
        });
        // Mirror into Skip textarea + chip highlight (clear on deselect).
        applySkipReason(metaSelectedReason || "");
      });
      wrap.appendChild(row);
      group.insertAdjacentElement("afterend", wrap);
      log("injected under metadata Data title");
    }

    const row = document.getElementById(META_ROW_ID);
    if (row) syncChipRow(row, metaSelectedReason);
    updateMetaCopyField(wrap, pathway, metaSelectedReason);
    return true;
  }

  function ensureAll() {
    if (!enabled) {
      tearDownChips();
      return;
    }
    ensureSkipChips();
    ensureMetaChips();
  }

  let debounceTimer = null;
  function scheduleEnsure() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      try {
        ensureAll();
      } catch (err) {
        log("ensure failed", err?.message || err);
      }
    }, 80);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "SKIP_CHIPS_SET_ENABLED") return false;
    setEnabled(message.enabled !== false);
    sendResponse({ ok: true, enabled });
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[STORAGE_ENABLED]) return;
    setEnabled(changes[STORAGE_ENABLED].newValue !== false);
  });

  const mo = new MutationObserver(scheduleEnsure);
  mo.observe(document.documentElement, { childList: true, subtree: true });

  loadEnabled().then(() => {
    if (enabled) scheduleEnsure();
    else tearDownChips();
  });

  window.__encordSkipReasonChips = {
    version: VERSION,
    ensure: ensureAll,
    reasons: REASONS.slice(),
    get enabled() {
      return enabled;
    },
  };
  log("ready", VERSION);
})();
