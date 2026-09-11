// Runs in the page's MAIN world (real React fibers / react-dnd).
(function () {
  const VERSION = "0.6.0";
  if (window.__encordLayoutPage?.version === VERSION) return;

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
    if (Array.isArray(val) && val.length && looksLikeLayout(val[0])) return true;
    return false;
  }

  function walkState(state, visit, depth = 0) {
    let s = state;
    let i = 0;
    while (s && i < 30 && depth < 5) {
      visit(s);
      // useMemo / useRef / useState shapes
      const m = s.memoizedState;
      if (m && typeof m === "object" && m !== s && "current" in m && looksLikeLayout(m.current)) {
        visit({ memoizedState: m.current, queue: null, __fromRef: true });
      }
      s = s.next;
      i += 1;
    }
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
        (looksLikeLayout(props.initialValue) && props.initialValue) ||
        null;

      const onChange =
        [props.onChange, props.onRelease, props.onLayoutChange, props.setLayout].find(
          (fn) => typeof fn === "function"
        ) || null;

      const mosaicActions =
        props.mosaicActions ||
        f.dependencies?.firstContext?.memoizedValue?.mosaicActions ||
        null;

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

      // Context values hanging on fiber
      try {
        let ctx = f.dependencies;
        let ci = 0;
        while (ctx && ci < 10) {
          const v = ctx.memoizedValue;
          if (v && looksLikeLayout(v.mosaicState ?? v.layout ?? v.value)) {
            stateLayout = v.mosaicState ?? v.layout ?? v.value;
          }
          if (v && typeof v.mosaicActions?.replaceWith === "function") {
            // keep reference via bestRef apply wrapper later
            if (!bestRef.mosaicActions) bestRef.mosaicActions = v.mosaicActions;
          }
          ctx = ctx.next;
          ci += 1;
        }
      } catch {
        /* ignore */
      }

      if (mosaicActions && !bestRef.mosaicActions) bestRef.mosaicActions = mosaicActions;

      const interesting =
        layout != null ||
        stateLayout != null ||
        onChange ||
        mosaicActions ||
        keys.some((k) => /layout|mosaic|onChange|onRelease|initialValue/i.test(k));

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
          hasMosaicActions: !!(mosaicActions || bestRef.mosaicActions),
          layoutSample: JSON.stringify(layout ?? stateLayout)?.slice(0, 2500) || null,
        };
        findings.push(entry);

        const candidateLayout = layout ?? stateLayout;
        const candidateApply =
          onChange ||
          stateSetter ||
          null;

        if (
          candidateLayout != null &&
          (!bestRef.best ||
            (candidateApply && !bestRef.best.apply) ||
            leavesOf(candidateLayout).length > leavesOf(bestRef.best.layout || null).length)
        ) {
          bestRef.best = {
            ...entry,
            layout: candidateLayout,
            apply: candidateApply,
          };
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

    // Also try React root containers on body/#root
    for (const el of [document.getElementById("root"), document.body, document.querySelector("#app")]) {
      if (!el) continue;
      for (const key of Object.keys(el)) {
        if (!key.startsWith("__reactContainer$") && key !== "_reactRootContainer") continue;
        let root = el[key];
        let fiber = root?.current || root?._internalRoot?.current || root;
        if (fiber) collectFromFiber(fiber, findings, bestRef, "react-root", 30);
      }
    }

    const seen = new Set();
    const deduped = [];
    for (const f of findings) {
      const k = `${f.depth}|${f.type}|${(f.layoutSample || "").slice(0, 60)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(f);
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
      _mosaicActions: bestRef.mosaicActions || null,
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
        hasMosaicActions: p.hasMosaicActions,
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
      hasMosaicActions: p.hasMosaicActions,
      reactFindings: p.findings,
      tree: null,
      leaves: [],
      fiberStartsChecked: p.fiberStartsChecked,
    };
  }

  function apply(tree) {
    const p = probe();
    if (typeof p._apply === "function") {
      try {
        p._apply(tree);
        return {
          attempted: true,
          applied: true,
          mode: "onChange/dispatch",
          type: p.bestType,
          depth: p.bestDepth,
          leaves: leavesOf(tree),
          version: VERSION,
        };
      } catch (err) {
        try {
          p._apply(() => tree);
          return {
            attempted: true,
            applied: true,
            mode: "functional-update",
            type: p.bestType,
            depth: p.bestDepth,
            leaves: leavesOf(tree),
            version: VERSION,
          };
        } catch (err2) {
          return {
            attempted: true,
            applied: false,
            error: err2.message || err.message,
            findings: p.findings,
            version: VERSION,
          };
        }
      }
    }

    return {
      attempted: true,
      applied: false,
      error: "no apply function on mosaic fiber",
      hasMosaicActions: p.hasMosaicActions,
      findings: p.findings,
      fiberStartsChecked: p.fiberStartsChecked,
      version: VERSION,
    };
  }

  window.__encordLayoutPage = {
    version: VERSION,
    capture,
    apply,
    probe,
  };
})();
