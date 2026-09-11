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

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isEncordUrl(url = "") {
  try {
    const { hostname } = new URL(url);
    return hostname === "app.encord.com" || hostname === "app.us.encord.com";
  } catch {
    return false;
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  }
}

async function runPageWorld(tabId, action, arg) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: ["page-world.js"],
    });

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (act, payload) => {
        const api = window.__encordLayoutPage;
        if (!api) return { attempted: true, applied: false, error: "__encordLayoutPage missing" };
        if (act === "capture") return api.capture();
        if (act === "apply") return api.apply(payload);
        if (act === "probe") return api.probe();
        return { attempted: true, applied: false, error: "unknown page-world action" };
      },
      args: [action, arg ?? null],
    });

    const result = results?.[0]?.result;
    if (result == null) {
      return {
        attempted: true,
        applied: false,
        error: "executeScript returned empty result",
        raw: results,
      };
    }
    return result;
  } catch (err) {
    return {
      attempted: true,
      applied: false,
      error: err.message || String(err),
    };
  }
}

async function sendToContent(type, extra = {}) {
  const tab = await getActiveTab();
  if (!tab?.id || !isEncordUrl(tab.url)) {
    throw new Error("Open an Encord label editor tab first (app.encord.com).");
  }
  await ensureContentScript(tab.id);
  return chrome.tabs.sendMessage(tab.id, { type, ...extra });
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
    `hasOnChange: ${mosaic.hasOnChange}`,
    `bestType: ${mosaic.bestType || "(none)"} depth=${mosaic.bestDepth ?? "?"}`,
    "tree:",
    mosaic.tree ? JSON.stringify(mosaic.tree, null, 2) : `(error: ${mosaic.error || "none"})`,
    "",
    "=== page-world react ===",
    `ok: ${pageWorld.ok} source: ${pageWorld.source || "?"} hasOnChange: ${pageWorld.hasOnChange} fibers=${pageWorld.fiberStartsChecked ?? "?"}`,
    `leaves: ${(pageWorld.leaves || []).join(", ") || "(none)"}`,
    pageWorld.tree
      ? `react tree:\n${JSON.stringify(pageWorld.tree, null, 2)}`
      : `error: ${pageWorld.error || "(none)"}`,
    "",
    "=== react findings ===",
    ...((pageWorld.reactFindings || mosaic.reactFindings || []).length
      ? (pageWorld.reactFindings || mosaic.reactFindings).map(
          (f) =>
            `- d${f.depth} ${f.type} layout=${f.hasLayout} state=${f.hasStateLayout} onChange=${f.hasOnChange} actions=${f.hasMosaicActions}` +
            (f.layoutSample ? `\n  sample: ${f.layoutSample.slice(0, 500)}` : "")
        )
      : ["(none)"]),
    "",
    "=== layout localStorage (truncated) ===",
    ...Object.entries(scan.layoutStorage || {}).map(
      ([k, v]) => `- ${k} = ${String(v).slice(0, 200)}`
    ),
  ];
  return lines.join("\n");
}

async function refreshPreview() {
  const { preferredCameras, preferredMosaicLayout } = await chrome.storage.local.get([
    "preferredCameras",
    "preferredMosaicLayout",
  ]);
  if (!preferredCameras?.length) {
    setStatus("No saved preference yet.");
    return;
  }
  const layoutNote = preferredMosaicLayout?.ok
    ? ` + mosaic(${preferredMosaicLayout.source})`
    : "";
  setStatus(
    `Saved ${preferredCameras.filter((c) => c.visible).length} camera(s)${layoutNote}.`,
    formatCameras(preferredCameras) +
      (preferredMosaicLayout?.tree
        ? `\n\ntree:\n${JSON.stringify(preferredMosaicLayout.tree, null, 2)}`
        : "")
  );
}

scanBtn.addEventListener("click", async () => {
  setBusy(true);
  setStatus("Scanning…");
  copyBtn.hidden = true;
  try {
    const tab = await getActiveTab();
    if (!tab?.id || !isEncordUrl(tab.url)) {
      throw new Error("Open an Encord label editor tab first.");
    }
    const pageWorld = await runPageWorld(tab.id, "capture");
    const result = await sendToContent("SCAN_PAGE", { pageWorld });
    if (!result?.ok && result?.error) throw new Error(result.error);
    lastScanText = formatScan(result);
    setStatus(
      `Scan done — mosaic=${result.mosaic?.source}, react=${pageWorld?.source || "none"}, onChange=${pageWorld?.hasOnChange}`,
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
  setStatus("Scan result copied. Paste it here in chat.");
  previewEl.hidden = false;
  previewEl.textContent = lastScanText;
  copyBtn.hidden = false;
});

saveBtn.addEventListener("click", async () => {
  setBusy(true);
  setStatus("Saving…");
  try {
    const tab = await getActiveTab();
    if (!tab?.id || !isEncordUrl(tab.url)) {
      throw new Error("Open an Encord label editor tab first.");
    }
    const pageWorld = await runPageWorld(tab.id, "capture");
    const result = await sendToContent("SAVE_CAMERAS", { pageWorld });
    if (!result?.ok) throw new Error(result?.error || "Save failed.");
    // Mirror into popup-visible storage shape (already set by content; refresh UI)
    setStatus(
      result.message || `Saved ${result.cameras.length} camera(s).`,
      formatCameras(result.cameras) +
        (result.mosaic?.tree ? `\n\ntree:\n${JSON.stringify(result.mosaic.tree, null, 2)}` : "")
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
    const tab = await getActiveTab();
    if (!tab?.id || !isEncordUrl(tab.url)) {
      throw new Error("Open an Encord label editor tab first.");
    }

    await ensureContentScript(tab.id);
    const saved = await chrome.tabs.sendMessage(tab.id, { type: "GET_SAVED_LAYOUT" });
    const layout = saved?.mosaic;

    if (!layout?.tree) {
      throw new Error(
        "Nothing saved yet. Shrink the extra pane to the right, arrange the rest, then Save."
      );
    }

    // Adapt saved tree to this episode: keep saved cameras, drop extras user removed,
    // only auto-attach ghost panes (no tile-display-name) minimized on the right.
    const visibleLeaves = (
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () =>
          [...document.querySelectorAll('[data-testid="tile-display-name"]')]
            .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
            .filter(Boolean),
      })
    )?.[0]?.result || [];

    const pageWorldApplyResult = await runPageWorld(tab.id, "apply", {
      tree: layout.tree,
      adapt: true,
      visibleLeaves,
    });

    const result = await sendToContent("RESTORE_CAMERAS", { pageWorldApplyResult });
    if (!result?.ok) throw new Error(result?.error || "Restore failed.");
    setStatus(
      result.message || "Restore finished.",
      (result.reactRestore?.tree
        ? `applied tree:\n${JSON.stringify(result.reactRestore.tree, null, 2)}\n\n`
        : "") +
        formatCameras(result.cameras) +
        `\n\nreact: ${JSON.stringify({
          applied: result.reactRestore?.applied,
          adapted: result.reactRestore?.adapted,
          error: result.reactRestore?.error,
          adaptInfo: result.reactRestore?.adaptInfo,
        })}`
    );
  } catch (err) {
    setStatus(err.message || String(err));
  } finally {
    setBusy(false);
  }
});

refreshPreview();
