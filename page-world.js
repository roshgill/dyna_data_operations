// Runs in the page's MAIN world (real React fibers).
(function () {
  const VERSION = "0.8.3";
  // Always refresh API when version changes.
  if (window.__encordLayoutPage?.version === VERSION) return;

  const MIN_RIGHT_SPLIT = 96; // first pane gets ~96%, ghost on the right ~4%

  function getFiberKey(el) {
    return Object.keys(el || {}).find(
      (k) =>
        k.startsWith("__reactFiber$") ||
        k.startsWith("__reactInternalInstance$") ||
        k.startsWith("__reactContainer$")
    );
  }

  function getFiber(el) {
    const key = getFiberKey(el);
    return key ? el[key] : null;
  }

  function leavesOf(node, out = []) {
    if (node == null) return out;
    if (typeof node === "string" || typeof node === "number") {
      out.push(String(node));
      return out;
    }
    if (Array.isArray(node)) {
      for (const c of node) leavesOf(c, out);
      return out;
    }
    if (typeof node === "object") {
      if (Array.isArray(node.children)) leavesOf(node.children, out);
      else {
        leavesOf(node.first, out);
        leavesOf(node.second, out);
      }
    }
    return out;
  }

  function looksLikeLayout(val) {
    if (val == null) return false;
    if (typeof val === "string" || typeof val === "number") return true;
    if (typeof val !== "object") return false;
    if ("first" in val && "second" in val) return true;
    if (val.type === "split" && Array.isArray(val.children)) return true;
    if (val.type === "tabs" && Array.isArray(val.tabs)) return true;
    return false;
  }

  function walkState(state, visit) {
    let s = state;
    let i = 0;
    while (s && i < 30) {
      visit(s);
      s = s.next;
      i += 1;
    }
  }

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function removeLeaf(tree, id) {
    if (tree == null) return null;
    if (typeof tree === "string" || typeof tree === "number") {
      return String(tree) === String(id) ? null : tree;
    }
    if (typeof tree !== "object") return tree;

    const first = removeLeaf(tree.first, id);
    const second = removeLeaf(tree.second, id);
    if (first == null && second == null) return null;
    if (first == null) return second;
    if (second == null) return first;
    return { ...tree, first, second };
  }

  /** Put `id` as a thin pane on the far right of the whole mosaic. */
  function addLeafMinimizedRight(tree, id, splitPercentage = MIN_RIGHT_SPLIT) {
    if (tree == null) return id;
    return {
      direction: "row",
      first: tree,
      second: id,
      splitPercentage,
    };
  }

  /**
   * Fit a saved layout onto the current episode.
   * - Saved leaves are the source of truth for which real cameras to show.
   * - Drop saved leaves that aren't in the current React layout at all.
   * - Only re-attach *ghost* panes (in current layout but not among visible
   *   tile-display-name cameras) — e.g. cam_high loading strip — minimized right.
   * - Do NOT re-add real cameras the user removed before Save (waist cams, etc.).
   */
  function adaptTree(savedTree, currentLeaves, visibleLeaves = []) {
    if (savedTree == null) return null;
    const current = [...new Set((currentLeaves || []).map(String))];
    const visible = new Set((visibleLeaves || []).map(String));
    let tree = clone(savedTree);

    for (const leaf of leavesOf(tree)) {
      if (!current.includes(leaf)) {
        tree = removeLeaf(tree, leaf);
      }
    }

    const have = new Set(leavesOf(tree));
    for (const leaf of current) {
      if (have.has(leaf)) continue;
      // Real, loaded camera tiles the user didn't save → stay omitted (deleted).
      if (visible.has(leaf)) continue;
      // Ghost / unloaded mosaic leaf (spinner pane) → keep, minimized on the right.
      tree = addLeafMinimizedRight(tree, leaf, MIN_RIGHT_SPLIT);
      have.add(leaf);
    }

    return tree;
  }

  function scoreCandidate(layout, applyFn, onChange) {
    let score = leavesOf(layout).length * 10;
    if (typeof applyFn === "function") score += 50;
    if (typeof onChange === "function") score += 30;
    return score;
  }

  function collectFromFiber(fiber, findings, bestRef, startLabel, maxDepth = 100) {
    let f = fiber;
    let depth = 0;
    while (f && depth < maxDepth) {
      const props = f.memoizedProps || {};
      const keys = Object.keys(props);
      const layout =
        (looksLikeLayout(props.layout) && props.layout) ||
        (looksLikeLayout(props.value) && props.value) ||
        null;

      const onChange =
        [props.onChange, props.onRelease, props.onLayoutChange, props.setLayout].find(
          (fn) => typeof fn === "function"
        ) || null;

      let stateLayout = null;
      let stateSetter = null;
      try {
        walkState(f.memoizedState, (s) => {
          const memo = s.memoizedState;
          if (looksLikeLayout(memo)) {
            stateLayout = memo;
            if (typeof s.queue?.dispatch === "function") stateSetter = s.queue.dispatch;
          }
        });
      } catch {
        /* ignore */
      }

      try {
        let ctx = f.dependencies;
        let ci = 0;
        while (ctx && ci < 10) {
          const v = ctx.memoizedValue;
          if (v && typeof v.mosaicActions?.replaceWith === "function") {
            bestRef.mosaicActions = v.mosaicActions;
          }
          ctx = ctx.next;
          ci += 1;
        }
      } catch {
        /* ignore */
      }

      const candidateLayout = layout ?? stateLayout;
      const candidateApply = onChange || stateSetter || null;
      const interesting =
        candidateLayout != null ||
        candidateApply ||
        keys.some((k) => /layout|mosaic|onChange|onRelease/i.test(k));

      if (interesting) {
        const entry = {
          depth,
          start: startLabel,
          type:
            f.type?.name ||
            f.elementType?.name ||
            f.elementType?.displayName ||
            (typeof f.type === "string" ? f.type : typeof f.type),
          propKeys: keys.slice(0, 40),
          hasLayout: layout != null,
          hasStateLayout: stateLayout != null,
          hasOnChange: typeof onChange === "function",
          hasStateSetter: typeof stateSetter === "function",
          layoutSample: JSON.stringify(candidateLayout)?.slice(0, 2500) || null,
        };
        findings.push(entry);

        if (candidateLayout != null) {
          const sc = scoreCandidate(candidateLayout, candidateApply, onChange);
          if (!bestRef.best || sc > bestRef.best._score) {
            bestRef.best = {
              ...entry,
              layout: candidateLayout,
              apply: candidateApply,
              _score: sc,
            };
          }
        }
      }

      f = f.return;
      depth += 1;
    }
  }

  function probe() {
    const findings = [];
    const bestRef = { best: null, mosaicActions: null };

    const starts = [
      ...document.querySelectorAll(
        ".mosaic, .mosaic-root, .mosaic-encord-theme, .mosaic-window, .mosaic-drop-target"
      ),
    ].slice(0, 30);

    for (const start of starts) {
      const fiber = getFiber(start);
      if (fiber) {
        collectFromFiber(
          fiber,
          findings,
          bestRef,
          (start.className || start.tagName || "").toString().slice(0, 80)
        );
      }
    }

    for (const el of [document.getElementById("root"), document.body, document.querySelector("#app")]) {
      if (!el) continue;
      for (const key of Object.keys(el)) {
        if (!key.startsWith("__reactContainer$") && key !== "_reactRootContainer") continue;
        const root = el[key];
        const fiber = root?.current || root?._internalRoot?.current || root;
        if (fiber) collectFromFiber(fiber, findings, bestRef, "react-root", 30);
      }
    }

    const seen = new Set();
    const deduped = [];
    for (const item of findings) {
      const k = `${item.depth}|${item.type}|${(item.layoutSample || "").slice(0, 60)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(item);
      if (deduped.length >= 30) break;
    }

    return {
      ok: true,
      source: "react-main",
      version: VERSION,
      findings: deduped,
      layout: bestRef.best?.layout ?? null,
      leaves: bestRef.best?.layout != null ? leavesOf(bestRef.best.layout) : [],
      hasOnChange: typeof bestRef.best?.apply === "function",
      hasMosaicActions: !!bestRef.mosaicActions,
      bestType: bestRef.best?.type || null,
      bestDepth: bestRef.best?.depth ?? null,
      _apply: bestRef.best?.apply || null,
      fiberStartsChecked: starts.length,
    };
  }

  function capture() {
    const p = probe();
    if (p.layout != null) {
      return {
        ok: true,
        source: "react-main",
        version: VERSION,
        tree: p.layout,
        leaves: p.leaves,
        hasOnChange: p.hasOnChange,
        bestType: p.bestType,
        bestDepth: p.bestDepth,
        reactFindings: p.findings,
        fiberStartsChecked: p.fiberStartsChecked,
      };
    }
    return {
      ok: false,
      source: "react-main",
      version: VERSION,
      error: "No React mosaic layout found in MAIN world",
      hasOnChange: false,
      reactFindings: p.findings,
      tree: null,
      leaves: [],
      fiberStartsChecked: p.fiberStartsChecked,
    };
  }

  function apply(payload) {
    const p = probe();
    let tree = payload;
    let adapted = false;
    let adaptInfo = null;

    // Allow { tree, adapt: true } or raw tree.
    if (payload && typeof payload === "object" && "tree" in payload) {
      tree = payload.tree;
      if (payload.adapt !== false) {
        const currentLeaves = p.leaves?.length ? p.leaves : leavesOf(p.layout);
        const visibleLeaves = Array.isArray(payload.visibleLeaves)
          ? payload.visibleLeaves
          : [];
        const before = leavesOf(tree);
        tree = adaptTree(tree, currentLeaves, visibleLeaves);
        adapted = true;
        adaptInfo = {
          savedLeaves: before,
          currentLeaves,
          visibleLeaves,
          resultLeaves: leavesOf(tree),
          omittedVisible: currentLeaves.filter(
            (id) => visibleLeaves.includes(id) && !before.includes(id)
          ),
        };
      }
    }

    if (tree == null) {
      return {
        attempted: true,
        applied: false,
        error: "no tree to apply",
        adaptInfo,
        version: VERSION,
      };
    }

    if (typeof p._apply !== "function") {
      return {
        attempted: true,
        applied: false,
        error: "no apply function on mosaic fiber",
        findings: p.findings,
        adaptInfo,
        version: VERSION,
      };
    }

    try {
      p._apply(tree);
      return {
        attempted: true,
        applied: true,
        mode: "onChange/dispatch",
        adapted,
        adaptInfo,
        type: p.bestType,
        depth: p.bestDepth,
        leaves: leavesOf(tree),
        tree,
        version: VERSION,
      };
    } catch (err) {
      try {
        p._apply(() => tree);
        return {
          attempted: true,
          applied: true,
          mode: "functional-update",
          adapted,
          adaptInfo,
          type: p.bestType,
          depth: p.bestDepth,
          leaves: leavesOf(tree),
          tree,
          version: VERSION,
        };
      } catch (err2) {
        return {
          attempted: true,
          applied: false,
          error: err2.message || err.message,
          adaptInfo,
          version: VERSION,
        };
      }
    }
  }

  function readCurrentFrame() {
    const el = document.querySelector('[data-testid="currentFrame"]');
    const n = Number(String(el?.textContent || "").replace(/[^\d]/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  /** Jump playhead via Ant/React onChange on the frame spinner (MAIN world). */
  function gotoFrame(frame) {
    const target = Math.max(0, Math.floor(Number(frame) || 0));
    const input = document.querySelector('[data-testid="content-navigation-frame-input"]');
    if (!input) return { ok: false, error: "no-frame-input" };

    let handled = false;
    let fiber = getFiber(input);
    let depth = 0;
    while (fiber && depth < 25 && !handled) {
      const props = fiber.memoizedProps || {};
      const onChange = props.onChange;
      if (typeof onChange === "function") {
        try {
          // Ant Design InputNumber may want number or event-like value
          onChange(target);
          handled = true;
          break;
        } catch {
          try {
            onChange({ target: { value: target } });
            handled = true;
            break;
          } catch {
            /* keep walking */
          }
        }
      }
      fiber = fiber.return;
      depth += 1;
    }

    if (!handled) {
      try {
        const proto = window.HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        desc?.set?.call(input, String(target));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        handled = true;
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    }

    const cur = readCurrentFrame();
    return {
      ok: cur != null && Math.abs(cur - target) <= 1,
      frame: cur,
      target,
      via: handled ? "react-or-dom" : "none",
      version: VERSION,
    };
  }

  // Bridge for isolated content scripts (grade sync)
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "encord-grade-sync") return;

    if (data.type === "GOTO_FRAME") {
      let result;
      try {
        result = gotoFrame(data.frame);
      } catch (err) {
        result = { ok: false, error: err.message || String(err) };
      }
      window.postMessage(
        { source: "encord-grade-sync", type: "GOTO_FRAME_RESULT", id: data.id, result },
        "*"
      );
      return;
    }

    if (data.type === "SET_RANGE_INPUT") {
      let result = { ok: false, error: "not-found" };
      try {
        const aria = String(data.ariaLabel || "");
        const frame = Math.max(0, Math.floor(Number(data.frame) || 0));
        const input =
          (aria && document.querySelector(`input[aria-label="${aria}"]`)) ||
          (aria &&
            [...document.querySelectorAll("input")].find((el) =>
              (el.getAttribute("aria-label") || "").includes(aria)
            ));
        if (!input) {
          result = { ok: false, error: "input-missing", aria };
        } else {
          let fiber = getFiber(input);
          let depth = 0;
          let handled = false;
          const tryCall = (fn, arg) => {
            if (typeof fn !== "function") return false;
            try {
              fn(arg);
              return true;
            } catch {
              return false;
            }
          };
          while (fiber && depth < 25 && !handled) {
            const props = fiber.memoizedProps || {};
            const fakeEvent = {
              target: { value: String(frame) },
              currentTarget: { value: String(frame) },
              key: "Enter",
              code: "Enter",
              keyCode: 13,
              which: 13,
              type: "change",
              preventDefault() {},
              stopPropagation() {},
            };
            handled =
              tryCall(props.onChange, fakeEvent) ||
              tryCall(props.onChange, String(frame)) ||
              tryCall(props.onChange, frame) ||
              tryCall(props.onPressEnter, fakeEvent) ||
              tryCall(props.onBlur, fakeEvent) ||
              tryCall(props.onInput, fakeEvent);
            if (!handled) {
              for (const key of Object.keys(props)) {
                if (!/frame|range|start|end|bound/i.test(key)) continue;
                const v = props[key];
                if (typeof v === "function" && tryCall(v, frame)) {
                  handled = true;
                  break;
                }
              }
            }
            fiber = fiber.return;
            depth += 1;
          }
          if (!handled) {
            const proto = window.HTMLInputElement.prototype;
            const desc = Object.getOwnPropertyDescriptor(proto, "value");
            desc?.set?.call(input, String(frame));
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            input.dispatchEvent(
              new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
            );
            handled = true;
          }
          result = {
            ok: String(input.value || "").replace(/[^\d]/g, "") === String(frame),
            value: input.value,
            handled,
            version: VERSION,
          };
        }
      } catch (err) {
        result = { ok: false, error: err.message || String(err) };
      }
      window.postMessage(
        { source: "encord-grade-sync", type: "SET_RANGE_RESULT", id: data.id, result },
        "*"
      );
    }
  });

  window.__encordLayoutPage = {
    version: VERSION,
    capture,
    apply,
    probe,
    gotoFrame,
    adaptTree,
    MIN_RIGHT_SPLIT,
  };
})();
