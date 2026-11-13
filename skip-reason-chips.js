// Inject quick skip-reason chips under the Skip task textarea.
(() => {
  const VERSION = "0.18.65-skip-chips";
  const ROW_ID = "dyna-skip-reason-chips";
  const REASONS = [
    "wrong dataset",
    "no complete step",
    "accident",
    "missing frames",
    "old fold",
  ];
  const LOG = "[dyna-skip-chips]";

  if (window.__encordSkipReasonChips?.version === VERSION) return;

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
        // Prefer the textarea closest to the Skip task button.
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

  function syncSelected(row, textarea) {
    const current = normalize(textarea.value);
    for (const chip of row.querySelectorAll("button[data-dyna-skip-reason]")) {
      const selected = normalize(chip.dataset.dynaSkipReason) === current && current.length > 0;
      chip.setAttribute("aria-pressed", selected ? "true" : "false");
      styleChip(chip, selected);
    }
  }

  function buildRow(textarea) {
    const existing = document.getElementById(ROW_ID);
    if (existing) existing.remove();

    const row = document.createElement("div");
    row.id = ROW_ID;
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
        const already = normalize(textarea.value) === normalize(reason);
        setTextareaValue(textarea, already ? "" : reason);
        syncSelected(row, textarea);
        try {
          textarea.focus();
        } catch {
          /* ignore */
        }
      });
      row.appendChild(chip);
    }

    textarea.insertAdjacentElement("afterend", row);
    syncSelected(row, textarea);

    if (!textarea.dataset.dynaSkipChipsBound) {
      textarea.dataset.dynaSkipChipsBound = "1";
      textarea.addEventListener("input", () => {
        const live = document.getElementById(ROW_ID);
        if (live) syncSelected(live, textarea);
      });
    }

    log("injected under skip textarea");
    return row;
  }

  function ensureChips() {
    const textarea = findSkipTextarea();
    if (!textarea) {
      const orphan = document.getElementById(ROW_ID);
      if (orphan) orphan.remove();
      return false;
    }

    const existing = document.getElementById(ROW_ID);
    if (existing && existing.previousElementSibling === textarea) {
      syncSelected(existing, textarea);
      return true;
    }

    buildRow(textarea);
    return true;
  }

  let debounceTimer = null;
  function scheduleEnsure() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      try {
        ensureChips();
      } catch (err) {
        log("ensure failed", err?.message || err);
      }
    }, 80);
  }

  const mo = new MutationObserver(scheduleEnsure);
  mo.observe(document.documentElement, { childList: true, subtree: true });
  scheduleEnsure();

  window.__encordSkipReasonChips = {
    version: VERSION,
    ensure: ensureChips,
    reasons: REASONS.slice(),
  };
  log("ready", VERSION);
})();
