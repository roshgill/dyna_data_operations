const statusEl = document.getElementById("status");
const previewEl = document.getElementById("preview");
const scanBtn = document.getElementById("scan");
const saveBtn = document.getElementById("save");
const restoreBtn = document.getElementById("restore");
const copyBtn = document.getElementById("copy");

let lastScanText = "";

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
  scanBtn.disabled = busy;
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

function formatScan(scan) {
  const mosaic = scan.mosaic || {};
  const pageWorld = scan.pageWorld || {};
  const lines = [
    `v${scan.version}  ${scan.url}`,
    "",
    "=== visible mosaic tiles ===",
    formatCameras(scan.visibleTiles || scan.discovered),
    "",
    "=== mosaic layout ===",
    `source: ${mosaic.source || "?"}  ok: ${mosaic.ok}`,
    `leaves: ${(mosaic.leaves || []).join(", ") || "(none)"}`,
    "tree:",
    mosaic.tree ? JSON.stringify(mosaic.tree, null, 2) : `(error: ${mosaic.error || "none"})`,
    "",
    "=== page-world react ===",
    `ok: ${pageWorld.ok} leaves: ${(pageWorld.leaves || []).join(", ") || "(none)"}`,
  ];
  return lines.join("\n");
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
    setStatus(parts.join("\n"), preferredMosaicLayout.tree
      ? JSON.stringify(preferredMosaicLayout.tree, null, 2)
      : formatCameras(preferredCameras || []));
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

scanBtn.addEventListener("click", async () => {
  setBusy(true);
  setStatus("Scanning…");
  copyBtn.hidden = true;
  try {
    const result = await LayoutOps.scan();
    if (!result?.ok && result?.error) throw new Error(result.error);
    lastScanText = formatScan(result);
    setStatus(
      `Scan done — mosaic=${result.mosaic?.source}, onChange=${result.pageWorld?.hasOnChange}`,
      lastScanText
    );
    copyBtn.hidden = false;
  } catch (err) {
    setStatus(err.message || String(err));
  } finally {
    setBusy(false);
  }
});

copyBtn.addEventListener("click", async () => {
  if (!lastScanText) return;
  await navigator.clipboard.writeText(lastScanText);
  setStatus("Scan result copied.");
  previewEl.hidden = false;
  previewEl.textContent = lastScanText;
  copyBtn.hidden = false;
});

saveBtn.addEventListener("click", async () => {
  setBusy(true);
  setStatus("Saving…");
  try {
    const result = await LayoutOps.save();
    if (!result?.ok) throw new Error(result?.error || "Save failed.");
    setStatus(
      result.message || "Saved.",
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
