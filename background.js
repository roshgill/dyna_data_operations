importScripts("layout-ops.js");

const MENU = {
  SAVE: "encord-layout-save",
  DETAILS: "encord-layout-details",
  RESTORE: "encord-layout-restore",
};

function installContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU.RESTORE,
      title: "Restore layout",
      contexts: ["action"],
    });
    chrome.contextMenus.create({
      id: MENU.SAVE,
      title: "Save layout",
      contexts: ["action"],
    });
    chrome.contextMenus.create({
      id: MENU.DETAILS,
      title: "Open details…",
      contexts: ["action"],
    });
  });
}

async function withErrorToast(tab, fn) {
  try {
    return await fn();
  } catch (err) {
    const message = err?.message || String(err);
    if (tab?.id) {
      await LayoutOps.toast(tab.id, message, "error");
    }
    await LayoutOps.setBadge("!", "#c62828", "#ffffff");
    await chrome.storage.local.set({
      lastAction: { type: "error", message, at: Date.now() },
    });
    console.warn("[Encord Camera Layout]", message);
    return { ok: false, error: message };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  installContextMenus();
  chrome.action.setTitle({
    title: "Dyna Ops: Encord Camera Layout. Click to restore layout · Right click to save layout | details",
  });
});

chrome.runtime.onStartup.addListener(() => {
  installContextMenus();
});

// Primary path: one click restores.
chrome.action.onClicked.addListener((tab) => {
  withErrorToast(tab, () => LayoutOps.restore(tab));
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU.RESTORE) {
    await withErrorToast(tab, () => LayoutOps.restore(tab));
    return;
  }
  if (info.menuItemId === MENU.SAVE) {
    await withErrorToast(tab, () => LayoutOps.save(tab));
    return;
  }
  if (info.menuItemId === MENU.DETAILS) {
    const params = new URLSearchParams();
    if (tab?.id) params.set("tabId", String(tab.id));
    const qs = params.toString();
    await chrome.windows.create({
      url: chrome.runtime.getURL(`popup.html${qs ? `?${qs}` : ""}`),
      type: "popup",
      width: 420,
      height: 720,
      focused: true,
    });
  }
});

// Popup / content can request the same ops.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "OPS_RESTORE") return LayoutOps.restore(message.tab);
    if (message?.type === "OPS_SAVE") return LayoutOps.save(message.tab);
    if (message?.type === "CHECK_LAYOUT_MISMATCH") {
      const tab = message.tab || sender.tab;
      return LayoutOps.checkMismatch(tab);
    }
    if (message?.type === "LOCK_EPISODE_DEFAULT") {
      const tab = message.tab || sender.tab;
      return LayoutOps.lockEpisodeDefault(tab);
    }
    if (message?.type === "CLEAR_EPISODE_DEFAULT") {
      return LayoutOps.clearEpisodeDefault();
    }
    return { ok: false, error: "Unknown background op." };
  })()
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
  return true;
});

// Ensure menus exist after extension reload / SW wake.
installContextMenus();
chrome.action.setTitle({
  title: "Dyna Ops: Encord Camera Layout. Click to restore layout · Right click to save layout | details",
});
