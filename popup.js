const statusEl = document.getElementById("status");
const previewEl = document.getElementById("preview");
const saveBtn = document.getElementById("save");
const restoreBtn = document.getElementById("restore");

function setStatus(message, detail) {
  statusEl.textContent = message;
  if (detail) {
    previewEl.hidden = false;
    previewEl.textContent = detail;
  } else {
    previewEl.hidden = true;
    previewEl.textContent = "";
  }
}

function setBusy(busy) {
  saveBtn.disabled = busy;
  restoreBtn.disabled = busy;
}

function formatCameras(cameras = []) {
  if (!cameras.length) return "(none)";
  return cameras
    .map((cam) => {
      const box = cam.w != null ? `  @(${cam.x},${cam.y} ${cam.w}x${cam.h})` : "";
      return `${cam.visible ? "ON " : "off"}  ${cam.id}${box}`;
    })
    .join("\n");
}

async function refreshPreview() {
  const { preferredCameras, preferredMosaicLayout, lastAction } = await chrome.storage.local.get([
    "preferredCameras",
    "preferredMosaicLayout",
    "lastAction",
  ]);

  const parts = [];
  if (lastAction?.message) {
    parts.push(`Last: ${lastAction.message}`);
  }
  if (preferredMosaicLayout?.ok) {
    parts.push(
      `Saved mosaic (${preferredMosaicLayout.source}): ${(preferredMosaicLayout.leaves || []).join(", ")}`
    );
    setStatus(
      parts.join("\n"),
      preferredMosaicLayout.tree
        ? JSON.stringify(preferredMosaicLayout.tree, null, 2)
        : formatCameras(preferredCameras || [])
    );
    return;
  }
  if (preferredCameras?.length) {
    setStatus(
      `Saved ${preferredCameras.filter((c) => c.visible).length} camera(s).`,
      formatCameras(preferredCameras)
    );
    return;
  }
  setStatus("No saved layout yet. Arrange panes, then right-click the extension icon → Save layout.");
}

saveBtn.addEventListener("click", async () => {
  setBusy(true);
  setStatus("Saving…");
  try {
    const result = await LayoutOps.save();
    if (!result?.ok) throw new Error(result?.error || "Save failed.");
    setStatus(
      "Saved layout",
      result.mosaic?.tree ? JSON.stringify(result.mosaic.tree, null, 2) : formatCameras(result.cameras)
    );
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
    const result = await LayoutOps.restore();
    if (!result?.ok) throw new Error(result?.error || "Restore failed.");
    setStatus(
      result.message || "Restored.",
      result.reactRestore?.tree
        ? JSON.stringify(result.reactRestore.tree, null, 2)
        : formatCameras(result.cameras)
    );
  } catch (err) {
    setStatus(err.message || String(err));
  } finally {
    setBusy(false);
  }
});

refreshPreview();
