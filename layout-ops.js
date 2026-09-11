// Shared layout operations — used by background (importScripts) and popup (script tag).
// eslint-disable-next-line no-unused-vars
const LayoutOps = (() => {
  function isEncordUrl(url = "") {
    try {
      const { hostname } = new URL(url);
      return hostname === "app.encord.com" || hostname === "app.us.encord.com";
    } catch {
      return false;
    }
  }

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
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

  async function requireEncordTab(tab) {
    const active = tab?.id ? tab : await getActiveTab();
    if (!active?.id || !isEncordUrl(active.url)) {
      throw new Error("Open an Encord label editor tab first (app.encord.com).");
    }
    await ensureContentScript(active.id);
    return active;
  }

  async function toast(tabId, message, kind = "info") {
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "SHOW_TOAST",
        message,
        kind,
      });
    } catch {
      /* page may not have content script yet */
    }
  }

  async function setBadge(text, color = "#5b3cc4") {
    try {
      await chrome.action.setBadgeBackgroundColor({ color });
      await chrome.action.setBadgeText({ text: text || "" });
      if (text) {
        setTimeout(() => {
          chrome.action.setBadgeText({ text: "" });
        }, 2500);
      }
    } catch {
      /* ignore */
    }
  }

  async function restore(tab) {
    const active = await requireEncordTab(tab);
    const saved = await chrome.tabs.sendMessage(active.id, { type: "GET_SAVED_LAYOUT" });
    const layout = saved?.mosaic;
    if (!layout?.tree) {
      throw new Error("Nothing saved yet. Right-click the icon → Save layout first.");
    }

    const visibleLeaves =
      (
        await chrome.scripting.executeScript({
          target: { tabId: active.id },
          func: () =>
            [...document.querySelectorAll('[data-testid="tile-display-name"]')]
              .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
              .filter(Boolean),
        })
      )?.[0]?.result || [];

    const pageWorldApplyResult = await runPageWorld(active.id, "apply", {
      tree: layout.tree,
      adapt: true,
      visibleLeaves,
    });

    const result = await chrome.tabs.sendMessage(active.id, {
      type: "RESTORE_CAMERAS",
      pageWorldApplyResult,
    });
    if (!result?.ok) throw new Error(result?.error || "Restore failed.");

    const message = result.message || "Layout restored.";
    await toast(active.id, message, result.reactRestore?.applied ? "ok" : "warn");
    await setBadge(result.reactRestore?.applied ? "OK" : "!", result.reactRestore?.applied ? "#2f6f3e" : "#a15c00");
    await chrome.storage.local.set({ lastAction: { type: "restore", message, at: Date.now() } });
    return result;
  }

  async function save(tab) {
    const active = await requireEncordTab(tab);
    const pageWorld = await runPageWorld(active.id, "capture");
    const result = await chrome.tabs.sendMessage(active.id, {
      type: "SAVE_CAMERAS",
      pageWorld,
    });
    if (!result?.ok) throw new Error(result?.error || "Save failed.");

    const message = result.message || "Layout saved.";
    await toast(active.id, message, "ok");
    await setBadge("SAV", "#2f6f3e");
    await chrome.storage.local.set({ lastAction: { type: "save", message, at: Date.now() } });
    return result;
  }

  return {
    isEncordUrl,
    getActiveTab,
    requireEncordTab,
    runPageWorld,
    restore,
    save,
    toast,
    setBadge,
  };
})();
