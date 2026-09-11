(() => {
  const VERSION = "0.8.2";
  const STORAGE_KEY = "preferredCameras";
  const LAYOUT_KEY = "preferredMosaicLayout";
  const PREFERRED_ACTIVE_TILE = "cam_high";

  if (window.__encordCameraLayoutHandler) {
    try {
      chrome.runtime.onMessage.removeListener(window.__encordCameraLayoutHandler);
    } catch {
      /* ignore */
    }
  }

  function normalizeLabel(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function mosaicWindowFor(el) {
    return el?.closest?.(".mosaic-window") || null;
  }

  function discoverVisibleTiles() {
    const names = document.querySelectorAll('[data-testid="tile-display-name"]');
    const cameras = [];
    const seen = new Set();

    for (const nameEl of names) {
      if (!isVisible(nameEl)) continue;
      const id = normalizeLabel(nameEl.textContent);
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const win = mosaicWindowFor(nameEl);
      const rect = (win || nameEl).getBoundingClientRect();
      cameras.push({
        id,
        visible: true,
        kind: "mosaic-tile",
        x: rect.left,
        y: rect.top,
        w: rect.width,
        h: rect.height,
        _nameEl: nameEl,
        _window: win,
      });
    }

    return cameras;
  }

  function serializeCameras(cameras) {
    return cameras.map(({ id, visible, kind, x, y, w, h }) => ({
      id,
      visible: !!visible,
      kind: kind || "unknown",
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h),
    }));
  }

  function buildSpatialTree(tiles) {
    if (!tiles.length) return null;
    if (tiles.length === 1) return tiles[0].id;

    const withRect = tiles.map((t) => ({
      ...t,
      left: t.x,
      right: t.x + t.w,
      top: t.y,
      bottom: t.y + t.h,
      cx: t.x + t.w / 2,
      cy: t.y + t.h / 2,
    }));

    function bestBipartition(items) {
      if (items.length < 2) return null;

      const byX = [...items].sort((a, b) => a.cx - b.cx);
      let bestX = null;
      for (let i = 0; i < byX.length - 1; i += 1) {
        const left = byX.slice(0, i + 1);
        const right = byX.slice(i + 1);
        const leftMax = Math.max(...left.map((t) => t.right));
        const rightMin = Math.min(...right.map((t) => t.left));
        const gap = rightMin - leftMax;
        const allLeft = left.every((t) => t.right <= rightMin + 1);
        const allRight = right.every((t) => t.left >= leftMax - 1);
        const score = gap + (allLeft && allRight ? 1000 : 0);
        if (!bestX || score > bestX.score) {
          const leftWidth = Math.max(...left.map((t) => t.right)) - Math.min(...left.map((t) => t.left));
          const total =
            Math.max(...items.map((t) => t.right)) - Math.min(...items.map((t) => t.left));
          bestX = {
            direction: "row",
            first: left,
            second: right,
            splitPercentage: Math.round((leftWidth / total) * 1000) / 10,
            score,
            gap,
          };
        }
      }

      const byY = [...items].sort((a, b) => a.cy - b.cy);
      let bestY = null;
      for (let i = 0; i < byY.length - 1; i += 1) {
        const top = byY.slice(0, i + 1);
        const bottom = byY.slice(i + 1);
        const topMax = Math.max(...top.map((t) => t.bottom));
        const bottomMin = Math.min(...bottom.map((t) => t.top));
        const gap = bottomMin - topMax;
        const score = gap + (gap > -2 ? 1000 : 0);
        if (!bestY || score > bestY.score) {
          const topHeight = Math.max(...top.map((t) => t.bottom)) - Math.min(...top.map((t) => t.top));
          const total =
            Math.max(...items.map((t) => t.bottom)) - Math.min(...items.map((t) => t.top));
          bestY = {
            direction: "column",
            first: top,
            second: bottom,
            splitPercentage: Math.round((topHeight / total) * 1000) / 10,
            score,
            gap,
          };
        }
      }

      if (!bestX) return bestY;
      if (!bestY) return bestX;
      if (bestX.gap > 2 && bestX.gap >= bestY.gap) return bestX;
      if (bestY.gap > 2 && bestY.gap > bestX.gap) return bestY;
      return bestX.score >= bestY.score ? bestX : bestY;
    }

    function build(items) {
      if (items.length === 1) return items[0].id;
      const part = bestBipartition(items);
      if (!part) return items.map((t) => t.id);
      return {
        direction: part.direction,
        first: build(part.first),
        second: build(part.second),
        splitPercentage: part.splitPercentage,
      };
    }

    return build(withRect);
  }

  function leavesOf(node, out = []) {
    if (node == null) return out;
    if (typeof node === "string") {
      out.push(node);
      return out;
    }
    if (typeof node === "object") {
      leavesOf(node.first, out);
      leavesOf(node.second, out);
    }
    return out;
  }

  function captureMosaicLayoutFromDom() {
    const tiles = discoverVisibleTiles();
    if (!tiles.length) {
      return { ok: false, source: "spatial-dom", error: "No tiles", tree: null, leaves: [] };
    }
    const tree = buildSpatialTree(tiles);
    return {
      ok: true,
      source: "spatial-dom",
      tree,
      leaves: leavesOf(tree),
      tileBoxes: serializeCameras(tiles),
    };
  }

  function readLayoutStorage() {
    const out = {};
    const interesting = [
      "encord-preferred-content-navigation-size",
      "editor-allotment-sizes",
      "left-sider-multi-selected-allotment-sizes",
      "left-sider-hard-selected-allotment-sizes",
      "left-sider-allotment-sizes",
      "timeline-allotment-sizes",
      "editor-left-sider-collapsed",
    ];
    for (const key of interesting) {
      try {
        out[key] = localStorage.getItem(key);
      } catch {
        out[key] = null;
      }
    }
    return out;
  }

  function findCloseButton(cam) {
    const toolbar = cam._window?.querySelector(".mosaic-window-toolbar");
    if (!toolbar) return null;
    const buttons = [...toolbar.querySelectorAll("button")].filter(isVisible);
    for (const b of buttons) {
      const label = normalizeLabel(
        b.getAttribute("aria-label") || b.getAttribute("title") || b.textContent
      ).toLowerCase();
      if (/close|remove|hide|delete/.test(label)) return b;
    }
    return null;
  }

  function dragHandleFor(cam) {
    const win = cam._window;
    if (!win) return null;
    return (
      win.querySelector('.mosaic-window-toolbar [draggable="true"]') ||
      win.querySelector(".mosaic-window-toolbar.draggable") ||
      win.querySelector('[draggable="true"]') ||
      win.querySelector(".mosaic-window-toolbar")
    );
  }

  function dropTargetFor(cam) {
    return cam._window || cam._nameEl;
  }

  function dispatchDrag(type, el, x, y, dataTransfer) {
    el.dispatchEvent(
      new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        dataTransfer,
        view: window,
      })
    );
  }

  function makeDataTransfer() {
    try {
      return new DataTransfer();
    } catch {
      const store = {};
      return {
        setData(k, v) {
          store[k] = String(v);
        },
        getData(k) {
          return store[k] || "";
        },
        clearData() {},
        setDragImage() {},
        dropEffect: "move",
        effectAllowed: "move",
        files: [],
        items: [],
        types: [],
      };
    }
  }

  async function simulateTileDrag(sourceCam, targetCam) {
    const source = dragHandleFor(sourceCam);
    const target = dropTargetFor(targetCam);
    if (!source || !target) return { ok: false, error: "missing drag handle/target" };

    const s = source.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    const x0 = s.left + Math.min(40, s.width / 2);
    const y0 = s.top + Math.min(12, s.height / 2);
    const x1 = t.left + t.width / 2;
    const y1 = t.top + t.height / 2;

    const dt = makeDataTransfer();
    dt.effectAllowed = "move";
    try {
      dt.setData("text/plain", sourceCam.id);
    } catch {
      /* ignore */
    }

    source.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        clientX: x0,
        clientY: y0,
        pointerId: 1,
        buttons: 1,
      })
    );
    source.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, clientX: x0, clientY: y0, buttons: 1 })
    );
    dispatchDrag("dragstart", source, x0, y0, dt);
    await new Promise((r) => setTimeout(r, 30));

    for (let i = 1; i <= 5; i += 1) {
      const x = x0 + ((x1 - x0) * i) / 5;
      const y = y0 + ((y1 - y0) * i) / 5;
      dispatchDrag("drag", source, x, y, dt);
      dispatchDrag("dragover", target, x, y, dt);
      target.dispatchEvent(
        new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y, buttons: 1 })
      );
      await new Promise((r) => setTimeout(r, 16));
    }

    dispatchDrag("dragenter", target, x1, y1, dt);
    dispatchDrag("dragover", target, x1, y1, dt);
    dispatchDrag("drop", target, x1, y1, dt);
    dispatchDrag("dragend", source, x1, y1, dt);
    source.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, clientX: x1, clientY: y1, buttons: 0 })
    );
    source.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        clientX: x1,
        clientY: y1,
        pointerId: 1,
        buttons: 0,
      })
    );
    await new Promise((r) => setTimeout(r, 120));
    return { ok: true, from: sourceCam.id, to: targetCam.id };
  }

  function center(cam) {
    return { x: cam.x + cam.w / 2, y: cam.y + cam.h / 2 };
  }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  async function restoreByDragging(savedCameras) {
    if (!savedCameras?.length || savedCameras.every((c) => c.x == null)) {
      return { attempted: false, swaps: [], error: "saved cameras lack positions" };
    }

    const targets = savedCameras
      .filter((c) => c.visible !== false && c.x != null)
      .map((c) => ({
        id: c.id,
        x: c.x,
        y: c.y,
        w: c.w,
        h: c.h,
        cx: c.x + c.w / 2,
        cy: c.y + c.h / 2,
      }));

    const swaps = [];
    const maxPasses = Math.max(targets.length * 2, 4);

    for (let pass = 0; pass < maxPasses; pass += 1) {
      const current = discoverVisibleTiles();
      const byId = new Map(current.map((c) => [c.id, c]));
      let moved = false;

      for (const target of targets) {
        const correct = byId.get(target.id);
        if (!correct) continue;

        let occupant = null;
        let best = Infinity;
        for (const cam of current) {
          const d = dist(center(cam), { x: target.cx, y: target.cy });
          if (d < best) {
            best = d;
            occupant = cam;
          }
        }
        if (!occupant || occupant.id === target.id) continue;

        const correctDist = dist(center(correct), { x: target.cx, y: target.cy });
        if (correctDist < Math.min(target.w, target.h) * 0.35) continue;

        swaps.push(await simulateTileDrag(correct, occupant));
        moved = true;
        break;
      }

      if (!moved) break;
    }

    return {
      attempted: true,
      swaps,
      swapCount: swaps.filter((s) => s.ok).length,
    };
  }

  function layoutsRoughlyMatch(savedCameras, currentCameras) {
    if (!savedCameras?.length || !currentCameras?.length) return false;
    if (savedCameras.length !== currentCameras.length) return false;
    const cur = new Map(currentCameras.map((c) => [c.id, c]));
    for (const s of savedCameras) {
      if (s.x == null) return false;
      const c = cur.get(s.id);
      if (!c) return false;
      if (dist(center(s), center(c)) > Math.min(s.w || 200, s.h || 200) * 0.4) return false;
    }
    return true;
  }

  async function saveCameras(pageWorld) {
    const cameras = discoverVisibleTiles();
    if (!cameras.length && !(pageWorld?.leaves?.length)) {
      return { ok: false, error: "No mosaic camera tiles found." };
    }

    const domMosaic = captureMosaicLayoutFromDom();
    // Prefer React tree (includes ghost panes like cam_high that have no tile-display-name).
    const mosaic =
      pageWorld?.ok && pageWorld.tree
        ? {
            ...pageWorld,
            spatial: domMosaic,
            ghostLeaves: (pageWorld.leaves || []).filter(
              (id) => !cameras.some((c) => c.id === id)
            ),
          }
        : { ...domMosaic, reactFindings: pageWorld?.reactFindings || [] };

    const payload = serializeCameras(cameras);
    const layoutStorage = readLayoutStorage();

    await chrome.storage.local.set({
      [STORAGE_KEY]: payload,
      [LAYOUT_KEY]: mosaic,
      preferredLayoutStorage: layoutStorage,
      savedAt: Date.now(),
      savedUrl: location.href,
    });

    const ghosts = mosaic.ghostLeaves || [];
    return {
      ok: true,
      cameras: payload,
      mosaic,
      message: `Saved layout (${mosaic.source}): ${
        mosaic.leaves?.join(", ") || payload.map((c) => c.id).join(", ")
      }${ghosts.length ? ` [ghost/minimized: ${ghosts.join(", ")}]` : ""}.`,
    };
  }

  async function restoreCameras(pageWorldApplyResult) {
    const stored = await chrome.storage.local.get([
      STORAGE_KEY,
      LAYOUT_KEY,
      "preferredLayoutStorage",
    ]);
    const preferred = stored[STORAGE_KEY] || [];
    const savedMosaic = stored[LAYOUT_KEY];

    let storageRestored = false;
    const preferredLayout = stored.preferredLayoutStorage;
    if (preferredLayout && typeof preferredLayout === "object") {
      for (const [key, value] of Object.entries(preferredLayout)) {
        if (typeof value !== "string") continue;
        try {
          if (localStorage.getItem(key) !== value) {
            localStorage.setItem(key, value);
            storageRestored = true;
          }
        } catch {
          /* ignore */
        }
      }
    }

    const reactRestore = pageWorldApplyResult || {
      attempted: false,
      applied: false,
      error: "page-world apply not run",
    };

    // Drag fallback only if React apply failed and we have positional boxes.
    let dragRestore = { attempted: false };
    if (!reactRestore.applied && preferred.length) {
      dragRestore = await restoreByDragging(preferred);
      await new Promise((r) => setTimeout(r, 150));
    }

    const after = serializeCameras(discoverVisibleTiles());
    const mosaicAfter = captureMosaicLayoutFromDom();

    let message;
    if (reactRestore.applied) {
      const adapt = reactRestore.adaptInfo;
      const leafNote = reactRestore.leaves?.join(", ") || "";
      message = `Restored mosaic via React (${reactRestore.mode || "ok"})${
        reactRestore.adapted ? " with 5/6 adapt" : ""
      }: ${leafNote}`;
      if (adapt?.currentLeaves?.length !== adapt?.savedLeaves?.length) {
        message += ` (saved ${adapt.savedLeaves.length} → now ${adapt.currentLeaves.length})`;
      }
    } else if (dragRestore.attempted) {
      message = `React apply failed (${reactRestore.error || "n/a"}); drag tried ${
        dragRestore.swapCount || 0
      } swap(s).`;
    } else if (savedMosaic?.ok) {
      message = `Tree saved (${savedMosaic.source}) but apply failed: ${
        reactRestore.error || "unknown"
      }.`;
    } else {
      message = "No saved mosaic tree. Arrange panes (shrink ghost to the right), then Save.";
    }

    // After layout settle, focus cam_high so annotating can start immediately.
    await new Promise((r) => setTimeout(r, 150));
    const selectResult = await selectTile(PREFERRED_ACTIVE_TILE);
    if (selectResult.ok) {
      message += ` · selected ${selectResult.tileId}`;
    }

    return {
      ok: true,
      storageRestored,
      reactRestore,
      dragRestore,
      selectResult,
      cameras: after,
      mosaicAfter,
      savedTree: savedMosaic?.tree || null,
      message,
    };
  }

  function showToast(message, kind = "info") {
    const existing = document.getElementById("encord-camera-layout-toast");
    if (existing) existing.remove();

    const el = document.createElement("div");
    el.id = "encord-camera-layout-toast";
    el.textContent = message;
    const bg =
      kind === "ok" ? "#1f6b3a" : kind === "error" ? "#8b1e1e" : kind === "warn" ? "#7a4b00" : "#2b2b2b";
    Object.assign(el.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: "2147483647",
      maxWidth: "420px",
      padding: "10px 14px",
      borderRadius: "10px",
      background: bg,
      color: "#fff",
      font: "13px/1.35 system-ui, -apple-system, sans-serif",
      boxShadow: "0 8px 24px rgba(0,0,0,.35)",
      opacity: "0",
      transition: "opacity .15s ease",
      pointerEvents: "none",
    });
    document.documentElement.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = "1";
    });
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 200);
    }, 3200);
  }

  function clickEl(el) {
    if (!el) return false;
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerId: 1, buttons: 1 }));
    el.dispatchEvent(new MouseEvent("mousedown", { ...opts, buttons: 1 }));
    el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerId: 1, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup", { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", opts));
    if (typeof el.focus === "function") {
      try {
        el.focus({ preventScroll: true });
      } catch {
        el.focus();
      }
    }
    return true;
  }

  function findTileWindow(tileId) {
    const id = String(tileId);

    // Prefer labeled mosaic tiles (real streams).
    for (const nameEl of document.querySelectorAll('[data-testid="tile-display-name"]')) {
      if (normalizeLabel(nameEl.textContent) === id) {
        return mosaicWindowFor(nameEl) || nameEl.closest(".mosaic-window") || nameEl;
      }
    }

    const byTag = document.querySelector(`[data-tile-id-tag="${CSS.escape(id)}"]`);
    if (byTag) return mosaicWindowFor(byTag) || byTag.closest(".mosaic-window") || byTag;

    const byToolbar = document.querySelector(`[data-testid="main-toolbar-${CSS.escape(id)}"]`);
    if (byToolbar) {
      return mosaicWindowFor(byToolbar) || byToolbar.closest(".mosaic-window") || byToolbar;
    }

    // Match video/source URLs that contain the camera id path segment.
    const media = [
      ...document.querySelectorAll("video, source, [src], [data-src]"),
    ];
    for (const el of media) {
      const src = el.getAttribute("src") || el.getAttribute("data-src") || "";
      if (!src) continue;
      if (
        src.includes(`/${id}/`) ||
        src.includes(`cam_${id}`) ||
        new RegExp(`(^|/)${id}(/|_|\\.|$)`).test(src)
      ) {
        return mosaicWindowFor(el) || el.closest(".mosaic-window") || el;
      }
    }

    return null;
  }

  function pickClickTarget(win) {
    if (!win) return null;
    return (
      win.querySelector('[data-testid="editor-content"]') ||
      win.querySelector("video") ||
      win.querySelector("canvas") ||
      win.querySelector(".mosaic-window-body") ||
      win.querySelector(".mosaic-window-toolbar") ||
      win
    );
  }

  async function selectTile(tileId = PREFERRED_ACTIVE_TILE, attempts = 6) {
    const id = tileId || PREFERRED_ACTIVE_TILE;
    for (let i = 0; i < attempts; i += 1) {
      const win = findTileWindow(id);
      const target = pickClickTarget(win);
      if (target && isVisible(target)) {
        clickEl(target);
        // Second click after a tick helps if the first only focuses the mosaic chrome.
        await new Promise((r) => setTimeout(r, 40));
        clickEl(target);
        return { ok: true, tileId: id, attempt: i + 1 };
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    return { ok: false, tileId: id, error: `Tile not found: ${id}` };
  }

  async function handleMessage(message) {
    if (message?.type === "PING") return { ok: true, version: VERSION };
    if (message?.type === "SHOW_TOAST") {
      showToast(message.message || "", message.kind || "info");
      return { ok: true };
    }
    if (message?.type === "SELECT_TILE") {
      return selectTile(message.tileId || PREFERRED_ACTIVE_TILE);
    }
    if (message?.type === "SAVE_CAMERAS") return saveCameras(message.pageWorld);
    if (message?.type === "RESTORE_CAMERAS") return restoreCameras(message.pageWorldApplyResult);
    if (message?.type === "GET_SAVED_LAYOUT") {
      const stored = await chrome.storage.local.get([LAYOUT_KEY]);
      return { ok: true, mosaic: stored[LAYOUT_KEY] || null };
    }
    return { ok: false, error: "Unknown action." };
  }

  window.__encordCameraLayoutHandler = (message, _sender, sendResponse) => {
    handleMessage(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  };

  chrome.runtime.onMessage.addListener(window.__encordCameraLayoutHandler);
  window.__encordCameraLayoutVersion = VERSION;
})();
