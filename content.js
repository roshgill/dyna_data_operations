(() => {
  const VERSION = "0.18.25";
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

  /** Match data-testid exactly, then case-insensitively (Encord: row-Step vs row-step). */
  function findByTestId(testId) {
    const exact = document.querySelector(`[data-testid="${testId}"]`);
    if (exact) return exact;
    const want = String(testId || "").toLowerCase();
    if (!want) return null;
    return (
      [...document.querySelectorAll("[data-testid]")].find(
        (el) => (el.getAttribute("data-testid") || "").toLowerCase() === want
      ) || null
    );
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
      return { ok: false, error: "No cameras found on this page." };
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
      message = "No saved layout yet. Arrange your cameras, then save.";
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

    // Success/info: Dyna Light off-white. Warn/error: hard red + white text.
    const palette =
      kind === "error" || kind === "warn"
        ? {
            background: "#c62828",
            color: "#ffffff",
            border: "1px solid rgba(0, 0, 0, 0.12)",
          }
        : {
            background: "#f2f0e9",
            color: "#1a1a1a",
            border: "1px solid rgba(26, 26, 26, 0.12)",
          };

    Object.assign(el.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: "2147483647",
      maxWidth: "420px",
      padding: "10px 14px",
      borderRadius: "10px",
      background: palette.background,
      color: palette.color,
      border: palette.border,
      font: '13px/1.35 "Avenir Next", "Segoe UI", "Helvetica Neue", Helvetica, sans-serif',
      boxShadow: "0 4px 16px rgba(26, 26, 26, 0.08)",
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

  function shortSelector(el) {
    if (!(el instanceof Element)) return "";
    const tag = el.tagName.toLowerCase();
    const testId = el.getAttribute("data-testid");
    if (testId) return `${tag}[data-testid="${testId}"]`;
    const id = el.id ? `#${CSS.escape(el.id)}` : "";
    const cls = [...el.classList].slice(0, 3).map((c) => `.${CSS.escape(c)}`).join("");
    const role = el.getAttribute("role");
    const roleBit = role ? `[role="${role}"]` : "";
    return `${tag}${id}${cls}${roleBit}`.slice(0, 160);
  }

  function attrsOf(el, limit = 18) {
    if (!(el instanceof Element)) return {};
    const out = {};
    for (const a of [...el.attributes].slice(0, limit)) {
      const v = a.value;
      if (v && v.length < 180) out[a.name] = v;
    }
    return out;
  }

  function describeEl(el, textMax = 160) {
    if (!(el instanceof Element)) return null;
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      selector: shortSelector(el),
      text: normalizeLabel(el.textContent).slice(0, textMax),
      attrs: attrsOf(el),
      visible: isVisible(el),
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
    };
  }

  function collectByText(patterns, { limit = 40 } = {}) {
    const hits = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node && hits.length < limit) {
      if (node instanceof Element && isVisible(node)) {
        const text = normalizeLabel(node.childNodes.length <= 3 ? node.textContent : "");
        // Prefer leaf-ish nodes so we don't capture giant ancestors.
        const own =
          node.childElementCount === 0
            ? normalizeLabel(node.textContent)
            : normalizeLabel(
                [...node.childNodes]
                  .filter((n) => n.nodeType === Node.TEXT_NODE)
                  .map((n) => n.textContent)
                  .join(" ")
              );
        const check = own || (node.childElementCount <= 2 ? text.slice(0, 120) : "");
        if (check && patterns.some((re) => re.test(check))) {
          hits.push(describeEl(node, 220));
        }
      }
      node = walker.nextNode();
    }
    return hits;
  }

  function collectTestIds(substrs, limit = 80) {
    const out = [];
    for (const el of document.querySelectorAll("[data-testid]")) {
      const id = el.getAttribute("data-testid") || "";
      if (!substrs.some((s) => id.toLowerCase().includes(s))) continue;
      out.push(describeEl(el, 200));
      if (out.length >= limit) break;
    }
    return out;
  }

  function collectInputsNearKeywords(keywords) {
    const inputs = [];
    for (const el of document.querySelectorAll("input, [contenteditable='true'], [role='spinbutton']")) {
      if (!isVisible(el)) continue;
      const nearby = normalizeLabel(
        `${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""} ${
          el.closest("label")?.textContent || ""
        } ${el.parentElement?.textContent || ""}`
      ).slice(0, 240);
      if (!keywords.some((k) => nearby.toLowerCase().includes(k))) continue;
      inputs.push({
        ...describeEl(el, 80),
        value: el instanceof HTMLInputElement ? el.value : normalizeLabel(el.textContent).slice(0, 40),
        nearby: nearby.slice(0, 160),
      });
      if (inputs.length >= 40) break;
    }
    return inputs;
  }

  function collectTimelineBars() {
    const bars = [];
    const candidates = document.querySelectorAll(
      '[class*="timeline"], [class*="Timeline"], [class*="track"], [class*="Track"], [class*="annotation"], [class*="Annotation"], [class*="range"], [class*="segment"], [data-testid*="timeline"], [data-testid*="track"], [data-testid*="classification"], [data-testid*="object"]'
    );
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const text = normalizeLabel(el.textContent).slice(0, 180);
      if (!/step|trajectory|grade|frames|quality|task done/i.test(text) && el.childElementCount > 12) {
        continue;
      }
      bars.push(describeEl(el, 180));
      if (bars.length >= 60) break;
    }
    return bars;
  }

  function snippetAround(el, depth = 3) {
    let cur = el;
    for (let i = 0; i < depth && cur?.parentElement; i += 1) cur = cur.parentElement;
    if (!cur) return "";
    return (cur.outerHTML || "").replace(/\s+/g, " ").slice(0, 1200);
  }

  function dumpSubtree(root, { maxNodes = 80, htmlMax = 2500 } = {}) {
    if (!(root instanceof Element)) return { present: false };
    const nodes = [];
    const all = [root, ...root.querySelectorAll("*")];
    for (const el of all) {
      if (nodes.length >= maxNodes) break;
      const testId = el.getAttribute("data-testid");
      const role = el.getAttribute("role");
      const ownText = normalizeLabel(
        [...el.childNodes]
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent)
          .join(" ")
      );
      const interesting =
        !!testId ||
        !!role ||
        el.tagName === "INPUT" ||
        el.tagName === "BUTTON" ||
        /step|grade|frame|traject|range|track|label/i.test(
          `${el.className} ${ownText} ${el.getAttribute("aria-label") || ""}`
        );
      if (!interesting && el !== root) continue;
      const rect = el.getBoundingClientRect();
      nodes.push({
        depth: (() => {
          let d = 0;
          let p = el;
          while (p && p !== root) {
            d += 1;
            p = p.parentElement;
          }
          return d;
        })(),
        tag: el.tagName.toLowerCase(),
        testId: testId || null,
        role: role || null,
        className: String(el.className || "").slice(0, 120),
        ownText: ownText.slice(0, 120),
        aria: el.getAttribute("aria-label") || null,
        value: el instanceof HTMLInputElement ? el.value : null,
        title: el.getAttribute("title") || null,
        style: (el.getAttribute("style") || "").slice(0, 160),
        rect: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
      });
    }
    return {
      present: true,
      selector: shortSelector(root),
      text: normalizeLabel(root.textContent).slice(0, 300),
      html: (root.outerHTML || "").replace(/\s+/g, " ").slice(0, htmlMax),
      nodes,
    };
  }

  function scanTimelineLabels() {
    const keywordRe = [
      /^trajectory$/i,
      /^step$/i,
      /^grade$/i,
      /^frames$/i,
      /^step\s*\d+/i,
      /^quality flag$/i,
      /^task done$/i,
      /^incomplete$/i,
    ];

    const textHits = collectByText(keywordRe, { limit: 50 });
    const testIds = collectTestIds([
      "timeline",
      "track",
      "frame",
      "classif",
      "object",
      "label",
      "editor",
      "attribute",
      "instance",
      "range",
      "step",
      "traject",
      "grade",
      "row-",
      "ontology",
    ]);
    const frameInputs = collectInputsNearKeywords(["frame", "frames", "start", "end", "from", "to"]);
    const timelineish = collectTimelineBars();

    const currentFrame = document.querySelector('[data-testid="currentFrame"]');
    const totalFrames = document.querySelector('[data-testid="totalFrames"]');
    const frameInput = document.querySelector('[data-testid="content-navigation-frame-input"]');

    const targeted = {
      currentFrame: currentFrame ? normalizeLabel(currentFrame.textContent) : null,
      totalFrames: totalFrames ? normalizeLabel(totalFrames.textContent) : null,
      frameInputValue: frameInput instanceof HTMLInputElement ? frameInput.value : null,
      rowTrajectory: dumpSubtree(findByTestId("row-trajectory")),
      rowStep: dumpSubtree(findByTestId("row-step")),
      classificationTimeline: dumpSubtree(
        document.querySelector('[data-testid="classification-timeline"]'),
        { maxNodes: 120, htmlMax: 3500 }
      ),
      scrollableTimeline: dumpSubtree(
        document.querySelector('[data-testid="scrollable-timeline-id"]'),
        { maxNodes: 100, htmlMax: 3000 }
      ),
      leftRows: dumpSubtree(document.querySelector('[data-testid="timeline-left-rows-id"]'), {
        maxNodes: 60,
        htmlMax: 2000,
      }),
      ontologyList: dumpSubtree(
        document.querySelector('[data-testid="editor-sider-ontology-list"]'),
        { maxNodes: 40, htmlMax: 1500 }
      ),
      labelsPane: dumpSubtree(
        document.querySelector('[data-testid="editor-sider-bottom-pane"]'),
        { maxNodes: 80, htmlMax: 2500 }
      ),
    };

    // Every data-testid under timeline rows (even empty)
    const rowTestIds = [];
    for (const root of [
      findByTestId("row-trajectory"),
      findByTestId("row-step"),
      document.querySelector('[data-testid="classification-timeline"]'),
    ]) {
      if (!root) continue;
      for (const el of root.querySelectorAll("[data-testid]")) {
        rowTestIds.push({
          testId: el.getAttribute("data-testid"),
          text: normalizeLabel(el.textContent).slice(0, 100),
          style: (el.getAttribute("style") || "").slice(0, 120),
          className: String(el.className || "").slice(0, 100),
        });
      }
    }

    // Visible inputs anywhere in sider / timeline (catch Frames 0 / N)
    const allVisibleInputs = [];
    for (const el of document.querySelectorAll("input")) {
      if (!isVisible(el)) continue;
      allVisibleInputs.push({
        testId: el.getAttribute("data-testid"),
        type: el.type,
        value: el.value,
        aria: el.getAttribute("aria-label"),
        nearby: normalizeLabel(el.parentElement?.textContent || "").slice(0, 100),
        selector: shortSelector(el),
      });
      if (allVisibleInputs.length >= 50) break;
    }

    function fmtDump(name, dump) {
      if (!dump?.present) return [`=== ${name} ===`, "(missing)", ""];
      const lines = [
        `=== ${name} ===`,
        `text: ${dump.text}`,
        `selector: ${dump.selector}`,
        `nodes (${dump.nodes.length}):`,
        ...dump.nodes.map(
          (n) =>
            `  ${"  ".repeat(Math.min(n.depth, 4))}- <${n.tag}> testid=${n.testId || "-"} role=${
              n.role || "-"
            } text="${n.ownText}" value=${n.value ?? "-"} style="${n.style}" ${n.rect.w}x${n.rect.h}`
        ),
        `html: ${dump.html}`,
        "",
      ];
      return lines;
    }

    const report = [
      `v${VERSION}  ${location.href}`,
      "",
      `=== frame nav ===`,
      `currentFrame: ${targeted.currentFrame}`,
      `totalFrames: ${targeted.totalFrames}`,
      `frameInput: ${targeted.frameInputValue}`,
      "",
      "=== text anchors (Trajectory / Step / Grade / Frames) ===",
      ...textHits.map(
        (h) =>
          `- ${h.text} | ${h.selector} | ${h.visible ? "vis" : "hid"} | ${h.rect.x},${h.rect.y} ${h.rect.w}x${h.rect.h}`
      ),
      textHits.length ? "" : "(none)",
      "",
      "=== all visible inputs ===",
      ...allVisibleInputs.map(
        (h) =>
          `- value="${h.value}" type=${h.type} testid=${h.testId || "-"} aria=${h.aria || "-"} nearby=${h.nearby}`
      ),
      allVisibleInputs.length ? "" : "(none)",
      "",
      "=== row/timeline data-testids ===",
      ...rowTestIds.map((h) => `- ${h.testId} | "${h.text}" | style=${h.style} | class=${h.className}`),
      rowTestIds.length ? "" : "(none)",
      "",
      ...fmtDump("row-trajectory", targeted.rowTrajectory),
      ...fmtDump("row-step", targeted.rowStep),
      ...fmtDump("classification-timeline", targeted.classificationTimeline),
      ...fmtDump("scrollable-timeline", targeted.scrollableTimeline),
      ...fmtDump("timeline-left-rows", targeted.leftRows),
      ...fmtDump("ontology-list", targeted.ontologyList),
      ...fmtDump("labels-pane", targeted.labelsPane),
      "=== data-testid hits (broad) ===",
      ...testIds.map((h) => `- ${h.attrs["data-testid"]} | ${h.text.slice(0, 80)} | ${h.selector}`),
      testIds.length ? "" : "(none)",
      "",
      "=== frame-ish inputs (keyword filter) ===",
      ...frameInputs.map((h) => `- value="${h.value}" | ${h.selector} | nearby: ${h.nearby}`),
      frameInputs.length ? "" : "(none)",
      "",
      "=== timeline-ish nodes (sample) ===",
      ...timelineish.slice(0, 15).map((h) => `- ${h.selector} | ${h.text.slice(0, 90)}`),
      timelineish.length ? "" : "(none)",
    ].join("\n");

    return {
      ok: true,
      report,
      summary: {
        textHits: textHits.length,
        frameInputs: frameInputs.length,
        testIds: testIds.length,
        timelineish: timelineish.length,
        rowTestIds: rowTestIds.length,
        inputs: allVisibleInputs.length,
        hasRowTrajectory: !!targeted.rowTrajectory.present,
        hasRowStep: !!targeted.rowStep.present,
        totalFrames: targeted.totalFrames,
        currentFrame: targeted.currentFrame,
      },
    };
  }

  function treeOutline(root, { maxDepth = 14, maxNodes = 2500, textMax = 80 } = {}) {
    if (!(root instanceof Element)) return ["(missing root)"];
    const lines = [];
    let count = 0;

    function walk(el, depth) {
      if (count >= maxNodes || depth > maxDepth) return;
      count += 1;
      const testId = el.getAttribute("data-testid");
      const role = el.getAttribute("role");
      const aria = el.getAttribute("aria-label");
      let ownText = normalizeLabel(
        [...el.childNodes]
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent)
          .join(" ")
      ).slice(0, textMax);
      // Radios / tree titles often have no direct text node — pull label text
      if (!ownText && (el.matches?.("label, [role='radio'], .ant-tree-title") || role === "treeitem")) {
        ownText = normalizeLabel(el.textContent || "").slice(0, textMax);
      }
      const checked = el.matches?.("label.ant-radio-wrapper, label, [role='radio']")
        ? isRadioCheckedEl(el)
        : false;
      const value = el instanceof HTMLInputElement ? el.value : "";
      const style = (el.getAttribute("style") || "").slice(0, 100);
      const cls = String(el.className || "")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 4)
        .join(".");
      const bits = [
        `<${el.tagName.toLowerCase()}>`,
        testId ? `testid=${testId}` : null,
        role ? `role=${role}` : null,
        aria ? `aria="${aria.slice(0, 60)}"` : null,
        ownText ? `text="${ownText}"` : null,
        checked ? "CHECKED" : null,
        value !== "" ? `value="${String(value).slice(0, 40)}"` : null,
        style ? `style="${style}"` : null,
        cls ? `class=${cls}` : null,
      ].filter(Boolean);
      lines.push(`${"  ".repeat(depth)}${bits.join(" ")}`);
      for (const child of el.children) walk(child, depth + 1);
    }

    walk(root, 0);
    if (count >= maxNodes) lines.push(`… truncated at ${maxNodes} nodes`);
    return lines;
  }

  function listAllTestIds(limit = 400) {
    const map = new Map();
    for (const el of document.querySelectorAll("[data-testid]")) {
      const id = el.getAttribute("data-testid") || "";
      if (!map.has(id)) {
        map.set(id, {
          testId: id,
          count: 0,
          sampleText: normalizeLabel(el.textContent).slice(0, 120),
          sampleStyle: (el.getAttribute("style") || "").slice(0, 140),
        });
      }
      map.get(id).count += 1;
    }
    return [...map.values()].slice(0, limit);
  }

  function listInteractive(limit = 200) {
    const out = [];
    const sel =
      'button, [role="button"], input, textarea, select, [contenteditable="true"], [data-testid="range"], kbd';
    for (const el of document.querySelectorAll(sel)) {
      if (!isVisible(el) && el.tagName !== "KBD") continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        testId: el.getAttribute("data-testid"),
        role: el.getAttribute("role"),
        aria: el.getAttribute("aria-label"),
        type: el instanceof HTMLInputElement ? el.type : null,
        value: el instanceof HTMLInputElement ? el.value : null,
        text: normalizeLabel(el.textContent).slice(0, 140),
        style: (el.getAttribute("style") || "").slice(0, 140),
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  function isRadioCheckedEl(el) {
    if (!el) return false;
    const input =
      (el.matches?.('input[type="radio"]') && el) ||
      el.querySelector?.('input[type="radio"]') ||
      null;
    if (input?.checked) return true;
    const wrap = el.closest?.("label.ant-radio-wrapper, label, [role='radio']") || el;
    if (wrap.classList?.contains("ant-radio-wrapper-checked")) return true;
    if (wrap.querySelector?.(".ant-radio-checked, [aria-checked='true']")) return true;
    if (wrap.getAttribute?.("aria-checked") === "true") return true;
    return false;
  }

  function radioLabelText(el) {
    if (!el) return "";
    const title = el.closest?.("[role='treeitem']")?.querySelector?.(".ant-tree-title");
    const raw =
      title?.textContent ||
      el.querySelector?.(".ant-radio + span, span:not(.ant-radio)")?.textContent ||
      el.textContent ||
      "";
    return normalizeLabel(raw).slice(0, 200);
  }

  /**
   * Left-panel classification dump — radios/treeitems with checked state.
   * Needed for S2: Step identity (first) + Incomplete (last / Outcome).
   */
  function scanClassificationPanel() {
    const lines = [];
    const panel =
      document.querySelector('[data-testid="object-left-panel"]') ||
      document.querySelector('[data-testid="editor-sider"]');
    const instanceName = normalizeLabel(
      document.querySelector('[data-testid="instance-name"]')?.textContent || ""
    );
    const rangeStart = document.querySelector('input[aria-label="Range start"]');
    const rangeEnd = document.querySelector('input[aria-label="Range end"]');
    const totalFrames = Number(
      normalizeLabel(document.querySelector('[data-testid="totalFrames"]')?.textContent || "") ||
        NaN
    );

    lines.push(`instance-name: ${instanceName || "(none)"}`);
    lines.push(
      `Range: ${rangeStart?.value ?? "?"}–${rangeEnd?.value ?? "?"}  totalFrames=${
        Number.isFinite(totalFrames) ? totalFrames : "?"
      }`
    );

    const kbds = [...(panel || document).querySelectorAll("kbd")]
      .map((k) => normalizeLabel(k.textContent))
      .filter(Boolean);
    lines.push(`hotkeys: ${kbds.length ? kbds.join(" ") : "(none)"}`);

    const doneBtn = [...(panel || document).querySelectorAll("button")].find((b) =>
      /^done(\s*esc)?$/i.test(normalizeLabel(b.textContent))
    );
    lines.push(`Done button: ${doneBtn ? normalizeLabel(doneBtn.textContent) : "(none)"}`);

    // Treeitems (preferred — preserves Step nesting / Outcome children)
    const treeItems = [...(panel || document).querySelectorAll('[role="treeitem"]')].filter(
      (el) => {
        const style = el.getAttribute("style") || "";
        if (/display:\s*none/i.test(style)) return false;
        return !!el.querySelector("label.ant-radio-wrapper, label, .ant-radio, [role='radio']");
      }
    );

    lines.push("");
    lines.push(`--- treeitem radios (${treeItems.length}) ---`);
    treeItems.forEach((item, i) => {
      const indentUnits = item.querySelectorAll(".ant-tree-indent-unit").length;
      const label =
        radioLabelText(item.querySelector("label.ant-radio-wrapper, label, [role='radio']") || item) ||
        normalizeLabel(item.querySelector(".ant-tree-title")?.textContent || "").slice(0, 200);
      const checked = isRadioCheckedEl(item.querySelector("label.ant-radio-wrapper, label") || item);
      const disabled =
        item.classList.contains("ant-tree-treenode-disabled") ||
        !!item.closest(".ant-tree-disabled");
      const open = item.classList.contains("ant-tree-treenode-switcher-open");
      const closed = item.classList.contains("ant-tree-treenode-switcher-close");
      const leaf = item.classList.contains("ant-tree-treenode-leaf");
      const cls = String(item.className || "")
        .split(/\s+/)
        .filter((c) => /checked|disabled|open|close|leaf|selected/i.test(c))
        .slice(0, 6)
        .join(" ");
      lines.push(
        `${i}: depth=${indentUnits} ${checked ? "CHECKED" : "·"} ${disabled ? "disabled" : "edit"} ${
          open ? "open" : closed ? "closed" : leaf ? "leaf" : ""
        } | "${label}" | ${cls}`
      );
    });

    // Flat radio labels (catch anything outside tree)
    const radios = [
      ...(panel || document).querySelectorAll("label.ant-radio-wrapper, [role='radio']"),
      ...[...(panel || document).querySelectorAll("label")].filter((el) =>
        el.querySelector('input[type="radio"]')
      ),
    ];
    const seenRadio = new Set();
    lines.push("");
    lines.push(`--- flat radios in panel ---`);
    let radioIdx = 0;
    for (const el of radios) {
      if (seenRadio.has(el)) continue;
      seenRadio.add(el);
      const label = radioLabelText(el);
      if (!label) continue;
      const checked = isRadioCheckedEl(el);
      const inTree = !!el.closest('[role="treeitem"]');
      lines.push(
        `${radioIdx}: ${checked ? "CHECKED" : "·"} ${inTree ? "tree" : "loose"} | "${label.slice(0, 160)}"`
      );
      radioIdx += 1;
    }
    lines.push(`(count: ${radioIdx})`);

    // Heuristic groups for S2 wiring
    const labels = treeItems.map((item) =>
      normalizeLabel(
        item.querySelector(".ant-tree-title")?.textContent || item.textContent || ""
      ).slice(0, 160)
    );
    const stepIds = labels.filter((t) => /^step\s*\d+/i.test(t));
    const outcomes = labels.filter((t) => /^(pass|fail|incomplete)[yui]?$/i.test(t.replace(/\s+/g, "")));
    const grades = labels.filter(
      (t) => /^-?\d+$/.test(t) || /^incomplete[i]?$/i.test(t.replace(/\s+/g, ""))
    );
    const incompleteHits = labels.filter((t) => /^incomplete[i]?$/i.test(t.replace(/\s+/g, "")));
    lines.push("");
    lines.push("--- S2 heuristics ---");
    lines.push(`step-identity options (Step N): ${stepIds.length ? stepIds.map((t) => t.slice(0, 60)).join(" || ") : "(none)"}`);
    lines.push(`first step option: ${stepIds[0] ? stepIds[0].slice(0, 80) : "(none)"}`);
    lines.push(`last step-identity option: ${stepIds.length ? stepIds[stepIds.length - 1].slice(0, 80) : "(none)"}`);
    lines.push(`Pass/Fail/Incomplete group: ${outcomes.length ? outcomes.join(", ") : "(none)"}`);
    lines.push(`Incomplete hits: ${incompleteHits.length ? incompleteHits.join(", ") : "(none)"}`);
    lines.push(
      `numeric/Incomplete grade-like: ${grades.length ? grades.join(", ") : "(none)"}`
    );

    // Selected timeline ranges with frame math
    lines.push("");
    lines.push("--- timeline ranges (frame math) ---");
    for (const rowId of ["row-Trajectory", "row-Step"]) {
      const row = findByTestId(rowId);
      if (!row) {
        lines.push(`${rowId}: (missing)`);
        continue;
      }
      const ranges = [...row.querySelectorAll('[data-testid="range"]')];
      ranges.forEach((r, i) => {
        const style = r.getAttribute("style") || "";
        const left = Number((/left:\s*([\d.]+)%/.exec(style) || [])[1]);
        const width = Number((/width:\s*([\d.]+)%/.exec(style) || [])[1]);
        const start =
          Number.isFinite(totalFrames) && Number.isFinite(left)
            ? Math.round((left / 100) * totalFrames)
            : "?";
        const end =
          Number.isFinite(totalFrames) && Number.isFinite(left) && Number.isFinite(width)
            ? Math.round(((left + width) / 100) * totalFrames)
            : "?";
        const label = normalizeLabel(r.textContent).slice(0, 80);
        const selected =
          /z-20|!text-white/.test(String(r.className || "")) ||
          /rgb\(74,\s*20,\s*169\)/.test(style) ||
          [...r.querySelectorAll('[data-testid="left-handle"], [data-testid="right-handle"]')].some(
            (h) => /opacity:\s*1\b/.test(h.getAttribute("style") || "")
          );
        lines.push(
          `${rowId}[${i}]: ${start}–${end} left=${left}% w=${width}% ${
            selected ? "SELECTED" : ""
          } | "${label}"`
        );
      });
    }

    return lines;
  }

  function scanFullEpisodeDom() {
    const roots = [
      ["editor-video-tool", document.querySelector('[data-testid="editor-video-tool"]')],
      ["editor-sider", document.querySelector('[data-testid="editor-sider"]')],
      ["editor-sider-top-pane", document.querySelector('[data-testid="editor-sider-top-pane"]')],
      ["editor-sider-ontology-list", document.querySelector('[data-testid="editor-sider-ontology-list"]')],
      ["editor-sider-bottom-pane", document.querySelector('[data-testid="editor-sider-bottom-pane"]')],
      ["classification-timeline", document.querySelector('[data-testid="classification-timeline"]')],
      ["scrollable-timeline-id", document.querySelector('[data-testid="scrollable-timeline-id"]')],
      ["row-trajectory", findByTestId("row-trajectory")],
      ["row-step", findByTestId("row-step")],
      ["row-quality flag", document.querySelector('[data-testid="row-quality flag"]')],
      ["row-task done", document.querySelector('[data-testid="row-task done"]')],
      ["editor-content-navigation", document.querySelector('[data-testid="editor-content-navigation"]')],
    ];

    // Also catch any other timeline rows (dynamic testids)
    for (const el of document.querySelectorAll('[data-testid^="row-"]')) {
      const id = el.getAttribute("data-testid");
      if (!roots.some((r) => r[0] === id)) roots.push([id, el]);
    }

    const currentFrame = normalizeLabel(
      document.querySelector('[data-testid="currentFrame"]')?.textContent || ""
    );
    const totalFrames = normalizeLabel(
      document.querySelector('[data-testid="totalFrames"]')?.textContent || ""
    );

    const testIds = listAllTestIds();
    const interactive = listInteractive();

    // Deep dumps with larger budgets for annotation-critical regions
    const deep = {
      ontology: dumpSubtree(document.querySelector('[data-testid="editor-sider-ontology-list"]'), {
        maxNodes: 200,
        htmlMax: 8000,
      }),
      topPane: dumpSubtree(document.querySelector('[data-testid="editor-sider-top-pane"]'), {
        maxNodes: 300,
        htmlMax: 10000,
      }),
      labelsPane: dumpSubtree(document.querySelector('[data-testid="editor-sider-bottom-pane"]'), {
        maxNodes: 250,
        htmlMax: 8000,
      }),
      timeline: dumpSubtree(document.querySelector('[data-testid="classification-timeline"]'), {
        maxNodes: 250,
        htmlMax: 10000,
      }),
      rowStep: dumpSubtree(findByTestId("row-step"), {
        maxNodes: 120,
        htmlMax: 6000,
      }),
      rowTrajectory: dumpSubtree(findByTestId("row-trajectory"), {
        maxNodes: 80,
        htmlMax: 4000,
      }),
    };

    function fmtDump(name, dump) {
      if (!dump?.present) return [`=== DEEP ${name} ===`, "(missing)", ""];
      return [
        `=== DEEP ${name} ===`,
        `text: ${dump.text}`,
        `nodes (${dump.nodes.length}):`,
        ...dump.nodes.map(
          (n) =>
            `  ${"  ".repeat(Math.min(n.depth, 5))}- <${n.tag}> testid=${n.testId || "-"} role=${
              n.role || "-"
            } text="${n.ownText}" value=${n.value ?? "-"} aria=${n.aria || "-"} style="${n.style}"`
        ),
        `html: ${dump.html}`,
        "",
      ];
    }

    const treeSections = [];
    for (const [name, el] of roots) {
      treeSections.push(
        `=== TREE ${name} ===`,
        ...(el ? treeOutline(el, { maxDepth: 16, maxNodes: name.includes("sider") || name.includes("timeline") ? 1800 : 800 }) : ["(missing)"]),
        ""
      );
    }

    // Body-level outline of high-signal nodes only (testid/role/aria/range)
    const bodySignal = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let n = walker.currentNode;
    let signalCount = 0;
    while (n && signalCount < 800) {
      if (n instanceof Element) {
        const testId = n.getAttribute("data-testid");
        const role = n.getAttribute("role");
        const aria = n.getAttribute("aria-label");
        const interesting =
          testId ||
          role === "button" ||
          role === "radio" ||
          role === "listbox" ||
          /frame|step|grade|traject|classif|ontology|label|range|timeline/i.test(
            `${testId || ""} ${aria || ""} ${n.tagName}`
          );
        if (interesting) {
          let depth = 0;
          let p = n.parentElement;
          while (p && p !== document.body) {
            depth += 1;
            p = p.parentElement;
          }
          bodySignal.push(
            `${"  ".repeat(Math.min(depth, 12))}<${n.tagName.toLowerCase()}> testid=${
              testId || "-"
            } role=${role || "-"} aria="${(aria || "").slice(0, 50)}" text="${normalizeLabel(
              n.childElementCount === 0 ? n.textContent : ""
            ).slice(0, 70)}" style="${(n.getAttribute("style") || "").slice(0, 90)}"`
          );
          signalCount += 1;
        }
      }
      n = walker.nextNode();
    }

    const classificationPanel = scanClassificationPanel();

    const report = [
      `v${VERSION} FULL-EPISODE-DOM  ${location.href}`,
      `title: ${document.title}`,
      `currentFrame: ${currentFrame}  totalFrames: ${totalFrames}`,
      `body children: ${document.body?.children?.length ?? 0}`,
      "",
      "=== CLASSIFICATION PANEL (S2 / Grade radios) ===",
      ...classificationPanel,
      "",
      "=== ALL data-testid (unique) ===",
      ...testIds.map(
        (t) => `- ${t.testId} ×${t.count} | "${t.sampleText}" | style=${t.sampleStyle}`
      ),
      "",
      "=== visible interactive (buttons/inputs/ranges/kbds) ===",
      ...interactive.map(
        (i) =>
          `- <${i.tag}> testid=${i.testId || "-"} role=${i.role || "-"} aria=${i.aria || "-"} type=${
            i.type || "-"
          } value=${i.value ?? "-"} text="${i.text}" style="${i.style}"`
      ),
      "",
      "=== BODY SIGNAL NODES (testid/role/annotation-ish) ===",
      ...bodySignal,
      "",
      ...fmtDump("ontology-list", deep.ontology),
      ...fmtDump("sider-top-pane", deep.topPane),
      ...fmtDump("labels-pane", deep.labelsPane),
      ...fmtDump("classification-timeline", deep.timeline),
      ...fmtDump("row-step", deep.rowStep),
      ...fmtDump("row-trajectory", deep.rowTrajectory),
      ...treeSections,
    ].join("\n");

    return {
      ok: true,
      report,
      summary: {
        chars: report.length,
        testIds: testIds.length,
        interactive: interactive.length,
        signalNodes: bodySignal.length,
        classificationPanelLines: classificationPanel.length,
        currentFrame,
        totalFrames,
        hasRowStep: !!findByTestId("row-step"),
        hasRowTrajectory: !!findByTestId("row-trajectory"),
      },
    };
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
    if (message?.type === "SCAN_TIMELINE") {
      return scanTimelineLabels();
    }
    if (message?.type === "SCAN_FULL_DOM") {
      return scanFullEpisodeDom();
    }
    return { ok: false, error: "Unknown action." };
  }

  window.__encordCameraLayoutHandler = (message, _sender, sendResponse) => {
    // Grade sync is handled by trajectory-sync.js
    if (String(message?.type || "").startsWith("GRADE_")) return false;
    handleMessage(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  };

  chrome.runtime.onMessage.addListener(window.__encordCameraLayoutHandler);
  window.__encordCameraLayoutVersion = VERSION;

  // Capture episode default early; warn only when that default differs from last saved default.
  let mismatchTimer = null;
  let autoLayoutTimer = null;
  let autoLayoutDoneKey = "";
  let autoLayoutInFlight = false;

  function episodeLayoutKey() {
    try {
      return new URL(location.href).pathname;
    } catch {
      return location.href;
    }
  }

  function mosaicLooksReady() {
    const tiles = document.querySelectorAll('[data-testid="tile-display-name"]').length;
    const windows = document.querySelectorAll(".mosaic-window").length;
    return tiles >= 1 && windows >= 1;
  }

  function scheduleEpisodeWatch() {
    clearTimeout(mismatchTimer);
    mismatchTimer = setTimeout(() => {
      chrome.runtime
        .sendMessage({ type: "LOCK_EPISODE_DEFAULT" })
        .then(() => chrome.runtime.sendMessage({ type: "CHECK_LAYOUT_MISMATCH" }))
        .catch(() => {});
    }, 1000);
  }

  function scheduleAutoLayout() {
    clearTimeout(autoLayoutTimer);
    autoLayoutTimer = setTimeout(() => {
      if (!mosaicLooksReady()) return;
      const key = episodeLayoutKey();
      if (autoLayoutDoneKey === key) return;

      chrome.storage.local.get(["autoLayoutEnabled", "preferredMosaicLayout"], (stored) => {
        if (chrome.runtime.lastError) return;
        if (stored.autoLayoutEnabled !== true) return;
        if (!stored.preferredMosaicLayout?.tree) return;
        if (autoLayoutDoneKey === key || autoLayoutInFlight) return;

        autoLayoutInFlight = true;
        chrome.runtime
          .sendMessage({ type: "TRY_AUTO_LAYOUT" })
          .then((result) => {
            // Mark done on success or intentional block (wrong camera set) — retry on hard errors.
            if (result?.ok || result?.blocked) autoLayoutDoneKey = key;
          })
          .catch(() => {})
          .finally(() => {
            autoLayoutInFlight = false;
          });
      });
    }, 1800);
  }

  if (!window.__encordLayoutMismatchWatch) {
    window.__encordLayoutMismatchWatch = true;
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        autoLayoutDoneKey = "";
        chrome.runtime.sendMessage({ type: "CLEAR_EPISODE_DEFAULT" }).catch(() => {});
        scheduleEpisodeWatch();
        scheduleAutoLayout();
      }
    }, 1000);

    let lastLeafHint = "";
    const mo = new MutationObserver(() => {
      const hint = `${document.querySelectorAll(".mosaic-window").length}:${
        document.querySelectorAll('[data-testid="tile-display-name"]').length
      }`;
      if (hint === lastLeafHint) return;
      lastLeafHint = hint;
      scheduleEpisodeWatch();
      scheduleAutoLayout();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.savedDefaultLeaves || changes.preferredMosaicLayout) {
        scheduleEpisodeWatch();
      }
      if (changes.autoLayoutEnabled?.newValue === true) {
        autoLayoutDoneKey = "";
        scheduleAutoLayout();
      }
    });

    scheduleEpisodeWatch();
    scheduleAutoLayout();
    setTimeout(scheduleEpisodeWatch, 2000);
    setTimeout(scheduleAutoLayout, 2000);
    setTimeout(scheduleEpisodeWatch, 4500);
    setTimeout(scheduleAutoLayout, 4500);
    setTimeout(scheduleEpisodeWatch, 8000);
    setTimeout(scheduleAutoLayout, 8000);
  }
})();
