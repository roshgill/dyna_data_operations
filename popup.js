const statusEl = document.getElementById("status");
const saveBtn = document.getElementById("save");
const restoreBtn = document.getElementById("restore");

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
  setStatus("No saved layout yet. Arrange panes, then Save.");
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

refreshStatus();
