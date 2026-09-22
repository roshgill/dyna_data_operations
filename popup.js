const statusEl = document.getElementById("status");
const saveBtn = document.getElementById("save");
const restoreBtn = document.getElementById("restore");
const scanBtn = document.getElementById("scan");
const scanFullBtn = document.getElementById("scan-full");
const copyScanBtn = document.getElementById("copy-scan");
const scanOut = document.getElementById("scan-out");
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

async function refreshGradeStatus() {
  try {
    const result = await LayoutOps.gradeStatus(await resolveTargetTab());
    if (!result?.ok) {
      gradeStatusEl.textContent = result?.error || "Open an Encord episode to see Grade status.";
      return;
    }
    autoGradeEl.checked = result.enabled !== false;
    const defined = result.definedSteps || result.snapshot?.definedSteps;
    const definedLabel =
      defined?.lastStepNum != null ? `Defined last Step: ${defined.lastStepNum}. ` : "";
    const snap = result.snapshot;
    if (!snap?.ready) {
      if (snap?.reason === "last-defined-step-not-on-timeline") {
        gradeStatusEl.textContent = `${definedLabel}Waiting for Step ${defined?.lastStepNum} on the timeline…`;
        return;
      }
      if (snap?.reason === "no-last-step" || snap?.reason === "no-defined-steps") {
        gradeStatusEl.textContent = definedLabel
          ? `${definedLabel}Waiting for that Step on the timeline…`
          : "Discovering Classes → Step list…";
        return;
      }
      gradeStatusEl.textContent = "Waiting for timeline…";
      return;
    }
    const step = snap.lastStep;
    const grade = snap.grade;
    if (!grade) {
      gradeStatusEl.textContent = `${definedLabel}Step ${step.stepNum} ends at frame ${step.endFrame}. Sync uses Range start/end.`;
      return;
    }
    if ((grade.span ?? grade.endFrame - grade.startFrame) <= 2) {
      gradeStatusEl.textContent = `${definedLabel}Step ${step.stepNum} → 0–${step.endFrame}. Tiny Grade pin — Sync will expand it.`;
      return;
    }
    gradeStatusEl.textContent = snap.needsSync
      ? `${definedLabel}Step ${step.stepNum} → 0–${step.endFrame}. Grade is ${grade.startFrame}–${grade.endFrame} (will sync).`
      : `${definedLabel}Synced: Grade 0–${grade.endFrame} matches step ${step.stepNum}.`;
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

autoGradeEl.addEventListener("change", async () => {
  try {
    await LayoutOps.setGradeEnabled(await resolveTargetTab(), autoGradeEl.checked);
    setStatus(autoGradeEl.checked ? "Auto Grade on." : "Auto Grade off.");
    await refreshGradeStatus();
  } catch (err) {
    setStatus(err.message || String(err));
  }
});

gradeSyncBtn.addEventListener("click", async () => {
  setBusy(true);
  setStatus("Syncing Grade…");
  try {
    const result = await LayoutOps.gradeSyncNow(await resolveTargetTab());
    if (result?.ok) {
      const end = result.snap?.target?.endFrame ?? result.snap?.lastStep?.endFrame;
      const step = result.snap?.lastStep?.stepNum;
      const how = result.method === "range-inputs" ? "Range inputs" : "C/V/M";
      setStatus(`Grade 0–${end} (step ${step}) via ${how}.`);
    } else {
      const why = result?.error || result?.reason || "Grade sync skipped.";
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
refreshGradeStatus();
