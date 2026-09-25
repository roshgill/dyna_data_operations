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
    // Details opens as its own popup window, so currentWindow is the panel —
    // not the Encord editor. Prefer the last-focused normal browser window.
    try {
      const win = await chrome.windows.getLastFocused({
        populate: true,
        windowTypes: ["normal"],
      });
      const active = win?.tabs?.find((t) => t.active);
      if (active?.id && isEncordUrl(active.url)) return active;
    } catch {
      /* ignore */
    }

    const encordTabs = await chrome.tabs.query({
      url: ["https://app.encord.com/*", "https://app.us.encord.com/*"],
    });
    const activeEncord = encordTabs.find((t) => t.active);
    if (activeEncord) return activeEncord;
    if (encordTabs.length) {
      return [...encordTabs].sort(
        (a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0)
      )[0];
    }

    const [fallback] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    return fallback;
  }

  async function ensureContentScript(tabId) {
    let needInject = false;
    try {
      await chrome.tabs.sendMessage(tabId, { type: "PING" });
    } catch {
      needInject = true;
    }
    if (!needInject) {
      try {
        const grade = await chrome.tabs.sendMessage(tabId, { type: "GRADE_SYNC_STATUS" });
        if (!grade?.ok) needInject = true;
      } catch {
        needInject = true;
      }
    }
    if (needInject) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js", "trajectory-sync.js"],
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

  async function setBadge(text, color = "#f2f0e9", textColor = "#1a1a1a") {
    try {
      await chrome.action.setBadgeBackgroundColor({ color });
      try {
        await chrome.action.setBadgeTextColor({ color: textColor });
      } catch {
        /* older Chrome */
      }
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
    // Lock episode default BEFORE restore changes the mosaic.
    const episodeDefault = await lockEpisodeDefault(active);

    const stored = await chrome.storage.local.get(["savedDefaultLeaves"]);
    const savedDefault = uniqLeaves(stored.savedDefaultLeaves || []);
    const currentDefault = uniqLeaves(episodeDefault?.leaves || []);

    // Saved preferred layout was built for a different default camera set — don't apply it.
    if (
      savedDefault.length &&
      currentDefault.length &&
      !sameLeafSet(savedDefault, currentDefault)
    ) {
      const message = "Camera set changed. Adjust layout, then Save.";
      await toast(active.id, message, "warn");
      await setBadge("!", "#c62828", "#ffffff");
      await chrome.storage.local.set({
        lastAction: { type: "restore-blocked", message, at: Date.now() },
      });
      return { ok: false, blocked: true, error: message };
    }

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

    const message = "Cameras adjusted";
    await toast(active.id, message, "ok");
    await setBadge("OK", "#f2f0e9", "#1a1a1a");
    await chrome.storage.local.set({
      lastAction: {
        type: "restore",
        message,
        detail: result.message || "",
        at: Date.now(),
      },
    });
    return result;
  }

  async function save(tab) {
    const active = await requireEncordTab(tab);
    // Prefer the default captured at episode load (before rearrange).
    let episodeDefault = await getLockedEpisodeDefault(active.url);
    if (!episodeDefault?.leaves?.length) {
      episodeDefault = await lockEpisodeDefault(active, { force: false });
    }

    const pageWorld = await runPageWorld(active.id, "capture");
    const result = await chrome.tabs.sendMessage(active.id, {
      type: "SAVE_CAMERAS",
      pageWorld,
    });
    if (!result?.ok) throw new Error(result?.error || "Save failed.");

    const defaultLeaves = episodeDefault?.leaves?.length
      ? uniqLeaves(episodeDefault.leaves)
      : uniqLeaves(pageWorld?.leaves || result?.mosaic?.leaves || []);

    const message = "Saved layout";
    await toast(active.id, message, "ok");
    await setBadge("SAV", "#f2f0e9", "#1a1a1a");
    await chrome.storage.local.set({
      savedDefaultLeaves: defaultLeaves,
      lastAction: { type: "save", message, detail: result.message || "", at: Date.now() },
      lastMismatchToastKey: "",
    });
    return result;
  }

  function uniqLeaves(a = []) {
    return [...new Set([...a].map(String))].sort();
  }

  function sameLeafSet(a = [], b = []) {
    const left = uniqLeaves(a);
    const right = uniqLeaves(b);
    if (left.length !== right.length) return false;
    return left.every((v, i) => v === right[i]);
  }

  function episodeUrlKey(url = "") {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname}?taskId=${u.searchParams.get("taskId") || ""}`;
    } catch {
      return url;
    }
  }

  async function getLockedEpisodeDefault(url) {
    const { currentEpisodeDefault } = await chrome.storage.local.get("currentEpisodeDefault");
    if (!currentEpisodeDefault) return null;
    if (currentEpisodeDefault.url !== episodeUrlKey(url)) return null;
    if (!currentEpisodeDefault.locked) return null;
    return currentEpisodeDefault;
  }

  /**
   * Capture and lock this episode's default camera set once (as loaded, before rearrange/restore).
   */
  async function lockEpisodeDefault(tab, { force = false } = {}) {
    const active = tab?.id ? tab : await getActiveTab();
    if (!active?.id || !isEncordUrl(active.url)) return null;
    if (!String(active.url || "").includes("/label_editor/")) return null;

    const urlKey = episodeUrlKey(active.url);
    const { currentEpisodeDefault } = await chrome.storage.local.get("currentEpisodeDefault");

    if (
      !force &&
      currentEpisodeDefault?.url === urlKey &&
      currentEpisodeDefault?.locked &&
      currentEpisodeDefault?.leaves?.length
    ) {
      return currentEpisodeDefault;
    }

    await ensureContentScript(active.id);
    const capture = await runPageWorld(active.id, "capture");
    const leaves = uniqLeaves(capture?.leaves || []);
    if (!leaves.length) return null;

    const pending =
      currentEpisodeDefault?.url === urlKey
        ? currentEpisodeDefault
        : { url: urlKey, candidate: null, stableHits: 0, locked: false };

    if (sameLeafSet(pending.candidate || [], leaves)) {
      pending.stableHits = (pending.stableHits || 0) + 1;
      pending.candidate = leaves;
    } else {
      pending.candidate = leaves;
      pending.stableHits = 1;
      pending.locked = false;
    }
    pending.url = urlKey;

    if (pending.stableHits >= 2 || force) {
      const locked = {
        url: urlKey,
        leaves: pending.candidate,
        locked: true,
        lockedAt: Date.now(),
      };
      await chrome.storage.local.set({ currentEpisodeDefault: locked });
      return locked;
    }

    await chrome.storage.local.set({ currentEpisodeDefault: pending });
    return null;
  }

  async function clearEpisodeDefault() {
    await chrome.storage.local.set({
      currentEpisodeDefault: null,
      lastMismatchToastKey: "",
    });
  }

  /**
   * Warn only when this episode's *default* camera set differs from the last saved default.
   * Preferred (Restore) layout is separate and may be a subset.
   */
  async function checkMismatch(tab) {
    const active = tab?.id ? tab : await getActiveTab();
    if (!active?.id || !isEncordUrl(active.url)) {
      return { matched: true, reason: "not-encord" };
    }
    if (!String(active.url || "").includes("/label_editor/")) {
      return { matched: true, reason: "not-editor" };
    }

    const stored = await chrome.storage.local.get([
      "savedDefaultLeaves",
      "lastMismatchToastKey",
    ]);
    const savedDefault = uniqLeaves(stored.savedDefaultLeaves || []);
    if (!savedDefault.length) {
      // Establish episode default early even before first Save.
      await lockEpisodeDefault(active);
      return { matched: true, reason: "no-saved-default" };
    }

    const episodeDefault = await lockEpisodeDefault(active);
    if (!episodeDefault?.locked || !episodeDefault.leaves?.length) {
      return { matched: true, reason: "default-not-locked" };
    }

    const currentDefault = uniqLeaves(episodeDefault.leaves);
    if (sameLeafSet(savedDefault, currentDefault)) {
      return {
        matched: true,
        reason: "defaults-match",
        savedDefault,
        currentDefault,
      };
    }

    const toastKey = `${episodeUrlKey(active.url)}::${currentDefault.join("|")}::${savedDefault.join("|")}`;
    if (toastKey === stored.lastMismatchToastKey) {
      return { matched: false, toasted: false, savedDefault, currentDefault };
    }

    await chrome.storage.local.set({ lastMismatchToastKey: toastKey });
    await toast(active.id, "New camera layout detected. Readjust, then Save.", "warn");
    return { matched: false, toasted: true, savedDefault, currentDefault };
  }

  async function scanTimeline(tab) {
    const active = await requireEncordTab(tab);
    const result = await chrome.tabs.sendMessage(active.id, { type: "SCAN_TIMELINE" });
    if (!result?.ok) throw new Error(result?.error || "Timeline scan failed.");
    return result;
  }

  async function scanFullDom(tab) {
    const active = await requireEncordTab(tab);
    const result = await chrome.tabs.sendMessage(active.id, { type: "SCAN_FULL_DOM" });
    if (!result?.ok) throw new Error(result?.error || "Full DOM scan failed.");
    return result;
  }

  async function focusEncordTab(tab) {
    const active = tab?.id ? tab : await requireEncordTab(tab);
    if (!active?.id) {
      throw new Error("Open an Encord label editor tab first (app.encord.com).");
    }
    try {
      await chrome.tabs.update(active.id, { active: true });
    } catch {
      /* tab may already be active */
    }
    if (typeof active.windowId === "number") {
      try {
        await chrome.windows.update(active.windowId, { focused: true });
      } catch {
        /* ignore */
      }
    }
    // Let Chromium move OS + document focus into the editor before UI automation.
    await new Promise((r) => setTimeout(r, 200));
    return active;
  }

  async function gradeStatus(tab) {
    const active = await requireEncordTab(tab);
    return chrome.tabs.sendMessage(active.id, { type: "GRADE_SYNC_STATUS" });
  }

  async function gradeSyncNow(tab) {
    const active = await requireEncordTab(tab);
    await focusEncordTab(active);
    return chrome.tabs.sendMessage(active.id, { type: "GRADE_SYNC_NOW" });
  }

  async function setGradeEnabled(tab, enabled) {
    const active = await requireEncordTab(tab);
    await chrome.storage.local.set({ autoGradeEnabled: !!enabled });
    try {
      await chrome.tabs.sendMessage(active.id, {
        type: "GRADE_SYNC_SET_ENABLED",
        enabled: !!enabled,
      });
    } catch {
      /* content may reload */
    }
    return { ok: true, enabled: !!enabled };
  }

  async function getAutoLayoutEnabled() {
    const stored = await chrome.storage.local.get("autoLayoutEnabled");
    return stored.autoLayoutEnabled === true;
  }

  async function setAutoLayoutEnabled(enabled) {
    await chrome.storage.local.set({ autoLayoutEnabled: !!enabled });
    return { ok: true, enabled: !!enabled };
  }

  /** Restore saved layout if auto-layout is on (used after episode render). */
  async function tryAutoLayout(tab) {
    const enabled = await getAutoLayoutEnabled();
    if (!enabled) return { ok: true, skipped: true, reason: "disabled" };

    const stored = await chrome.storage.local.get("preferredMosaicLayout");
    const layout = stored.preferredMosaicLayout;
    if (!layout?.tree) return { ok: true, skipped: true, reason: "no-layout" };

    return restore(tab);
  }

  return {
    isEncordUrl,
    getActiveTab,
    requireEncordTab,
    runPageWorld,
    restore,
    save,
    scanTimeline,
    scanFullDom,
    gradeStatus,
    gradeSyncNow,
    setGradeEnabled,
    getAutoLayoutEnabled,
    setAutoLayoutEnabled,
    tryAutoLayout,
    checkMismatch,
    lockEpisodeDefault,
    clearEpisodeDefault,
    toast,
    setBadge,
  };
})();
