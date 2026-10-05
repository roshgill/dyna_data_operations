const statusEl = document.getElementById("status");
const saveBtn = document.getElementById("save");
const restoreBtn = document.getElementById("restore");
const scanBtn = document.getElementById("scan");
const scanFullBtn = document.getElementById("scan-full");
const copyScanBtn = document.getElementById("copy-scan");
const scanOut = document.getElementById("scan-out");
const autoLayoutEl = document.getElementById("auto-layout");
const autoScrollEl = document.getElementById("auto-scroll");
const autoGradeEl = document.getElementById("auto-grade");
const gradeStatusEl = document.getElementById("grade-status");
const gradeSyncBtn = document.getElementById("grade-sync");

const openerTabId = Number(new URLSearchParams(location.search).get("tabId") || "");

async function resolveTargetTab() {
  if (Number.isFinite(openerTabId) && openerTabId > 0) {
    try {
      const tab = await chrome.tabs.get(openerTabId);
      if (tab?.id && LayoutOps.isEncordUrl(tab.url)) return tab;
    } catch {
      /* tab closed — fall through */
    }
  }
  return undefined;
}

function setStatus(message) {
  statusEl.classList.remove("is-visible");
  void statusEl.offsetWidth;
  statusEl.textContent = message || "";
  if (message) statusEl.classList.add("is-visible");
}

function setBusy(busy) {
  saveBtn.disabled = busy;
  restoreBtn.disabled = busy;
  scanBtn.disabled = busy;
  scanFullBtn.disabled = busy;
  gradeSyncBtn.disabled = busy;
}

async function refreshStatus() {
  const { preferredMosaicLayout, lastAction } = await chrome.storage.local.get([
    "preferredMosaicLayout",
    "lastAction",
  ]);

  if (lastAction?.message) {
    setStatus(lastAction.message);
    return;
  }
  if (preferredMosaicLayout?.ok) {
    setStatus("Layout saved.");
    return;
  }
  setStatus("No camera layout saved yet. Adjust your cameras, then save.");
}


async function refreshAutoLayoutToggle() {
  try {
    autoLayoutEl.checked = await LayoutOps.getAutoLayoutEnabled();
  } catch {
    autoLayoutEl.checked = true;
  }
}

async function refreshAutoScrollToggle() {
  try {
    autoScrollEl.checked = await LayoutOps.getAutoScrollEnabled();
  } catch {
    autoScrollEl.checked = true;
  }
}

async function refreshGradeStatus() {
  try {
    const result = await LayoutOps.gradeStatus(await resolveTargetTab());
    if (!result?.ok) {
      gradeStatusEl.textContent = result?.error || "Open an Encord episode to see Grade status.";
      return;
    }
    autoGradeEl.checked = result.enabled === true;
    const defined = result.definedSteps || result.snapshot?.definedSteps;
    const snap = result.snapshot;
    if (!snap?.ready) {
      if (snap?.reason === "last-defined-step-not-on-timeline") {
        gradeStatusEl.textContent = `Waiting for Step ${defined?.lastStepNum} on the timeline…`;
        return;
      }
      if (snap?.reason === "no-last-step" || snap?.reason === "no-defined-steps") {
        gradeStatusEl.textContent = defined?.lastStepNum
          ? "Waiting for that Step on the timeline…"
          : "Discovering Classes → Step list…";
        return;
      }
      gradeStatusEl.textContent = "Waiting for timeline…";
      return;
    }
    const step = snap.lastStep;
    const grade = snap.grade;
    const tail = snap.tailTarget;
    const tailGrade = snap.tailGrade;
    const tailBit = tail
      ? tailGrade && !snap.needsSync
        ? ` Tail ${tailGrade.startFrame}–${tailGrade.endFrame}.`
        : ` Tail → ${tail.startFrame}–${tail.endFrame}.`
      : "";
    if (!grade) {
      gradeStatusEl.textContent = `Step ${step.stepNum} ends at frame ${step.endFrame}. Sync uses Range start/end.${tailBit}`;
      return;
    }
    if ((grade.span ?? grade.endFrame - grade.startFrame) <= 2) {
      gradeStatusEl.textContent = `Step ${step.stepNum} → 0–${step.endFrame}. Tiny Grade pin — Sync will expand it.${tailBit}`;
      return;
    }
    gradeStatusEl.textContent = snap.needsSync
      ? `Step ${step.stepNum} → 0–${step.endFrame}. Grade is ${grade.startFrame}–${grade.endFrame} (will sync).${tailBit}`
      : `Synced: Grade 0–${grade.endFrame} matches step ${step.stepNum}.${tailBit}`;
  } catch (err) {
    gradeStatusEl.textContent = err.message || String(err);
  }
}

saveBtn.addEventListener("click", async () => {
  setBusy(true);
  setStatus("Saving…");
  try {
    const result = await LayoutOps.save(await resolveTargetTab());
    if (!result?.ok) throw new Error(result?.error || "Save failed.");
    setStatus("Saved layout");
  } catch (err) {
    setStatus(err.message || String(err));
  } finally {
    setBusy(false);
  }
});

restoreBtn.addEventListener("click", async () => {
  setBusy(true);
  setStatus("Restoring…");
  try {
    const result = await LayoutOps.restore(await resolveTargetTab());
    if (!result?.ok) throw new Error(result?.error || "Restore failed.");
    setStatus("Cameras adjusted");
  } catch (err) {
    setStatus(err.message || String(err));
  } finally {
    setBusy(false);
  }
});


autoLayoutEl.addEventListener("change", async () => {
  try {
    await LayoutOps.setAutoLayoutEnabled(autoLayoutEl.checked);
    setStatus(autoLayoutEl.checked ? "Auto layout on." : "Auto layout off.");
  } catch (err) {
    setStatus(err.message || String(err));
  }
});

autoScrollEl.addEventListener("change", async () => {
  try {
    await LayoutOps.setAutoScrollEnabled(await resolveTargetTab(), autoScrollEl.checked);
    setStatus(autoScrollEl.checked ? "Auto scroll on." : "Auto scroll off.");
  } catch (err) {
    setStatus(err.message || String(err));
  }
});

autoGradeEl.addEventListener("change", async () => {
  try {
    await LayoutOps.setGradeEnabled(await resolveTargetTab(), autoGradeEl.checked);
    setStatus(autoGradeEl.checked ? "Auto annotation on." : "Auto annotation off.");
    await refreshGradeStatus();
  } catch (err) {
    setStatus(err.message || String(err));
  }
});

gradeSyncBtn.addEventListener("click", async () => {
  setBusy(true);
  setStatus("Focusing editor…");
  try {
    const tab = await resolveTargetTab();
    // Background focuses the Encord tab first so Grade create isn't stuck on an unfocused page.
    const result = await chrome.runtime.sendMessage({ type: "OPS_GRADE_SYNC_NOW", tab });
    if (result?.ok) {
      setStatus("Annotation complete");
    } else if (
      result?.reason === "waiting-for-last-defined-step" ||
      result?.reason === "last-defined-step-not-on-timeline"
    ) {
      const n = result.wantStep ?? result.snap?.definedSteps?.lastStepNum;
      setStatus(n != null ? `Waiting for Step ${n}` : "Waiting for Step list");
    } else if (result?.reason === "no-defined-steps" || result?.reason === "no-last-step") {
      setStatus("Waiting for Step list");
    } else {
      const why = result?.error || result?.reason || "Annotation skipped.";
      setStatus(why);
    }
    await refreshGradeStatus();
  } catch (err) {
    setStatus(err.message || String(err));
  } finally {
    setBusy(false);
  }
});

async function runScan(kind) {
  setBusy(true);
  setStatus(kind === "full" ? "Scanning full episode DOM…" : "Scanning timeline…");
  copyScanBtn.disabled = true;
  try {
    const tab = await resolveTargetTab();
    const result =
      kind === "full" ? await LayoutOps.scanFullDom(tab) : await LayoutOps.scanTimeline(tab);
    scanOut.value = result.report || JSON.stringify(result, null, 2);
    copyScanBtn.disabled = !scanOut.value;
    const s = result.summary || {};
    if (kind === "full") {
      const kb = Math.round((s.chars || scanOut.value.length) / 1024);
      setStatus(`Full DOM ready (~${kb} KB). Copy and paste to Cursor.`);
    } else {
      setStatus("Timeline scan ready. Copy and paste to Cursor.");
    }
  } catch (err) {
    scanOut.value = "";
    setStatus(err.message || String(err));
  } finally {
    setBusy(false);
  }
}

scanFullBtn.addEventListener("click", () => runScan("full"));
scanBtn.addEventListener("click", () => runScan("timeline"));

copyScanBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(scanOut.value);
    setStatus("Copied scan result.");
  } catch {
    scanOut.focus();
    scanOut.select();
    setStatus("Copy failed — select the text and copy manually.");
  }
});

refreshStatus();
refreshAutoLayoutToggle();
refreshAutoScrollToggle();
refreshGradeStatus();
