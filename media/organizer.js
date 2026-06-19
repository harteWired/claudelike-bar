// @ts-nocheck
/* Tile-organizer panel — vanilla JS, native HTML5 drag/drop, no deps.
   The webview owns the lane layout; on drop, we ship the full picture
   (pinnedOrder, unpinnedNames, hiddenNames) back to the extension which
   applies it atomically through ConfigManager.applyOrganizerLayout. */
(function () {
  const vscode = acquireVsCodeApi();

  // Lane keys map to the data-lane attributes in organizer.html.
  const LANE_KEYS = ['pinned', 'auto', 'closedVisible', 'hidden'];

  // Whether each lane accepts drops. closedVisible is no longer passive —
  // dropping a live tile there asks the extension to close the terminal
  // (with an optional confirmation modal). Dropping a non-live tile from
  // pinned/hidden into closedVisible is a config-only flag clear, routed
  // through the same applyLayout pipeline as a drop into auto-sort.
  const DROPPABLE = {
    pinned: true,
    auto: true,
    closedVisible: true,
    hidden: true,
  };

  // v0.19 (#47) — under the target-state model (#46), every cross-lane drop
  // is meaningful. The destination's runtime requirement (live vs closed)
  // determines whether the drop also triggers a launch (#44) or a close
  // (#41); the config flip happens regardless. The earlier blanket
  // rejection on `closedVisible → auto` (#38) was the symptom of trying to
  // suppress a runtime-required drop instead of executing it — it now
  // launches the terminal, satisfying Auto-sort's "live tiles only" rule.
  //
  // The only invalid drop is one whose destination isn't a real lane
  // (defensive against a future fifth lane key arriving in a stale state).
  function isDropAllowed(srcLane, dstLane) {
    if (!DROPPABLE[dstLane]) return false;
    // Same lane + no position metadata = nothing-to-do drops (the in-lane
    // reorder handler already short-circuits the "drop on self" case via
    // moveCard's position.relative === name check).
    if (srcLane === dstLane) return true;
    return true;
  }

  // v0.19 (#49) — drop-preview footer copy. Pure function so behavior is
  // self-evident and the table reads as a spec: source lane × destination
  // lane × runtime liveness → terse verb-and-name announcement of what
  // the drop will do. Returns null when the drop is a no-op (same lane,
  // same position) — the footer stays empty.
  //
  // Terse over descriptive per the 0.19.0 plan: "Launch X" reads at a
  // glance while dragging, where "Drop here to launch project X" is
  // visual noise once the convention is known.
  function dropPreview(srcLane, dstLane, srcIsLive, name) {
    if (!srcLane || !dstLane || !name) return null;
    if (srcLane === dstLane) return null;
    if (dstLane === 'pinned') {
      if (srcLane === 'hidden') return srcIsLive ? `Unhide + pin ${name}` : `Unhide + launch + pin ${name}`;
      if (srcLane === 'closedVisible') return `Launch + pin ${name}`;
      return `Pin ${name}`;
    }
    if (dstLane === 'auto') {
      if (srcLane === 'hidden') return srcIsLive ? `Unhide ${name}` : `Unhide + launch ${name}`;
      if (srcLane === 'closedVisible') return `Launch ${name}`;
      if (srcLane === 'pinned') return `Unpin ${name}`;
      return null;
    }
    if (dstLane === 'closedVisible') {
      if (srcIsLive) return `Close ${name}`;
      if (srcLane === 'pinned') return `Unpin ${name}`;
      if (srcLane === 'hidden') return `Unhide ${name}`;
      return null;
    }
    if (dstLane === 'hidden') {
      return `Hide ${name}`;
    }
    return null;
  }
  // Exported on globalThis for the syntax-guard / future unit access.
  // Webview script is an IIFE; this is the only escape hatch.
  if (typeof globalThis !== 'undefined') {
    globalThis.__organizerDropPreview = dropPreview;
  }

  let state = {
    pinned: [],
    auto: [],
    closedVisible: [],
    hidden: [],
  };

  let dragSrc = null; // { name, lane } of the card being dragged
  // Element currently showing a drop-before/drop-after placeholder. Cached
  // so dragover (60fps hot path) can clear the prior indicator with a
  // single classList op instead of a document-wide querySelectorAll.
  let currentDropTarget = null;
  // Most recent organizer:state message arrived during a drag — applied in
  // dragend so the in-flight drop isn't clobbered by a mid-drag rebuild.
  let pendingState = null;
  // v0.19 (#49) — true while the footer shows a drop-preview message
  // (e.g. "Launch foo"). Cleared on dragend / dragleave / successful drop.
  let previewShown = false;
  // v0.19 — cache of the preview string most recently rendered to the
  // footer. The lane-level dragover handler fires at ~60fps; without this
  // guard each frame would burn a setStatus() DOM write and a template-
  // literal allocation even though the action text hasn't changed.
  let lastPreview = null;

  function laneEl(key) {
    return document.querySelector(`.lane[data-lane="${key}"] .cards`);
  }

  function render() {
    for (const key of LANE_KEYS) {
      const container = laneEl(key);
      if (!container) continue;
      container.innerHTML = '';
      const cards = state[key] || [];
      if (cards.length === 0) {
        container.classList.add('empty');
        const empty = document.createElement('div');
        empty.className = 'empty-msg';
        empty.textContent = laneEmptyHint(key);
        container.appendChild(empty);
      } else {
        container.classList.remove('empty');
        for (const card of cards) {
          container.appendChild(makeCardEl(card, key));
        }
      }
    }
  }

  function laneEmptyHint(key) {
    if (key === 'pinned') return 'Drag tiles here to pin them at the bar bottom.';
    if (key === 'auto') return 'No running tiles — open a Claude terminal to populate.';
    if (key === 'closedVisible') return 'No registered tiles waiting for launch.';
    if (key === 'hidden') return 'Drag tiles here to hide them from the bar.';
    return '';
  }

  function makeCardEl(card, lane) {
    const el = document.createElement('div');
    el.className = 'card';
    el.draggable = true;
    el.dataset.name = card.name;
    el.dataset.lane = lane;
    el.style.setProperty('--card-color', card.themeColor);

    const icon = document.createElement('span');
    icon.className = 'card-icon codicon';
    if (card.icon) icon.classList.add(`codicon-${card.icon}`);
    else icon.classList.add('codicon-terminal');
    el.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'card-name';
    name.textContent = card.displayName;
    name.title = card.name === card.displayName
      ? card.name
      : `${card.displayName} (${card.name})`;
    el.appendChild(name);

    // v0.19 (#49) — runtime status dot. Green when the terminal is live,
    // grey when closed. Renders on every card so users see the runtime
    // axis at a glance, before deciding to drag.
    const dot = document.createElement('span');
    dot.className = `live-dot ${card.isLive ? 'live' : 'closed'}`;
    dot.title = card.isLive ? 'Terminal running' : 'Terminal closed';
    el.appendChild(dot);

    if (card.isShell) {
      const tag = document.createElement('span');
      tag.className = 'shell-tag';
      tag.textContent = 'shell';
      el.appendChild(tag);
    }

    el.addEventListener('dragstart', (e) => {
      // v0.19 (#49) — carry the runtime liveness + display name so the
      // drop-preview footer can announce what each drop will do without
      // re-finding the card on every dragover.
      dragSrc = {
        name: card.name,
        lane,
        isLive: !!card.isLive,
        displayName: card.displayName,
      };
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // setData is required for drag to fire in some browsers/webviews.
      try { e.dataTransfer.setData('text/plain', card.name); } catch (_) {}
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      dragSrc = null;
      // Cleanup any lingering placeholders.
      if (currentDropTarget) {
        currentDropTarget.classList.remove('drop-before', 'drop-after');
        currentDropTarget = null;
      }
      document.querySelectorAll('.cards.drag-over')
        .forEach((c) => c.classList.remove('drag-over'));
      // Clear a lingering drop-preview status when the drop ends without
      // landing on a target (drop on an invalid spot, Escape, etc.). A
      // successful drop replaces it with 'Saved.' or 'Launching…' via
      // sendLayout.
      if (previewShown) {
        setStatus('', false);
        previewShown = false;
      }
      lastPreview = null;
      // Apply any state update that arrived during the drag — we deferred
      // it so the dragged DOM node wouldn't get clobbered mid-gesture.
      if (pendingState) {
        const next = pendingState;
        pendingState = null;
        applyState(next);
      }
    });

    // Within-lane reorder: card-level dragover marks before/after.
    el.addEventListener('dragover', (e) => {
      if (!dragSrc) return;
      const targetLaneKey = el.dataset.lane;
      if (!isDropAllowed(dragSrc.lane, targetLaneKey)) return;
      // Auto-sort lane has no persisted order — within-lane reorder is a
      // no-op there, so don't draw the placeholder. Cross-lane drops still
      // work via the lane-container dragover handler.
      if (targetLaneKey === 'auto') return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = el.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      // Clear the prior indicator (if any) and mark this one. Single
      // classList op per move beats a document-wide query at 60fps.
      if (currentDropTarget && currentDropTarget !== el) {
        currentDropTarget.classList.remove('drop-before', 'drop-after');
      } else if (currentDropTarget === el) {
        // Same target as last frame — only flip the before/after side if
        // the cursor crossed the midline.
        el.classList.remove('drop-before', 'drop-after');
      }
      el.classList.add(before ? 'drop-before' : 'drop-after');
      currentDropTarget = el;
    });
    el.addEventListener('drop', (e) => {
      if (!dragSrc) return;
      const targetLaneKey = el.dataset.lane;
      if (!isDropAllowed(dragSrc.lane, targetLaneKey)) return;
      if (targetLaneKey === 'auto') return; // fall through to lane-level drop
      e.preventDefault();
      e.stopPropagation();
      const before = el.classList.contains('drop-before');
      const targetName = el.dataset.name;
      moveCard(dragSrc.name, dragSrc.lane, targetLaneKey, { relative: targetName, before });
    });

    return el;
  }

  // Lane-level drop handlers — for drops onto empty space inside a lane,
  // and for lanes where intra-lane order isn't tracked (auto-sort).
  function wireLaneContainers() {
    for (const key of LANE_KEYS) {
      const container = laneEl(key);
      if (!container) continue;
      container.addEventListener('dragover', (e) => {
        if (!dragSrc) return;
        if (!isDropAllowed(dragSrc.lane, key)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        container.classList.add('drag-over');
        // v0.19 (#49) — announce the action this drop will take. Terse
        // verb+name format keeps the footer scannable while dragging.
        // Cache the last computed preview string so the 60fps dragover
        // doesn't burn a setStatus() DOM write every frame — only update
        // when the preview text actually changes.
        const preview = dropPreview(dragSrc.lane, key, dragSrc.isLive, dragSrc.displayName);
        if (preview && preview !== lastPreview) {
          setStatus(preview, false);
          previewShown = true;
          lastPreview = preview;
        }
      });
      container.addEventListener('dragleave', (e) => {
        // Only clear when leaving the container (not when crossing into a
        // child card). relatedTarget is the element we're entering.
        if (e.relatedTarget && container.contains(e.relatedTarget)) return;
        container.classList.remove('drag-over');
        // Clear the preview text when the cursor leaves the lane — the
        // next lane the user hovers will set its own preview.
        if (previewShown) {
          setStatus('', false);
          previewShown = false;
          lastPreview = null;
        }
      });
      container.addEventListener('drop', (e) => {
        if (!dragSrc) return;
        container.classList.remove('drag-over');
        if (!isDropAllowed(dragSrc.lane, key)) return;
        // If a child card already handled this drop, bail — its handler
        // calls stopPropagation(). This branch covers empty-lane drops and
        // drops past the last card in a lane.
        e.preventDefault();
        moveCard(dragSrc.name, dragSrc.lane, key, { append: true });
      });
    }
  }

  // Apply a move to the local state, then ship the full layout to the host.
  function moveCard(name, srcLane, dstLane, position) {
    if (!srcLane || !dstLane) return;
    if (!isDropAllowed(srcLane, dstLane)) return;
    if (srcLane === dstLane && position && position.relative === name) return;

    // Find the card up-front so the live-tile-into-closedVisible branch can
    // route on its `isLive` flag without touching local lane state.
    const srcArr = state[srcLane];
    const idx = srcArr.findIndex((c) => c.name === name);
    if (idx === -1) return;
    const sourceCard = srcArr[idx];

    // Live tile → closedVisible means "close the terminal" — runtime action,
    // not a config edit. Let the extension show the confirmation modal and
    // dispose the terminal; the next state push will reflect the result
    // naturally. No local lane mutation here — if the user cancels, nothing
    // should change in the panel. (Non-live tiles fall through to the
    // standard config-only path: clearing pinned/hidden lands them in
    // closedVisible via runtime derivation in postState.)
    if (dstLane === 'closedVisible' && sourceCard.isLive) {
      vscode.postMessage({
        type: 'organizer:closeTerminal',
        name: sourceCard.name,
        displayName: sourceCard.displayName,
      });
      return;
    }

    // v0.19 (#44) — closed (non-live) tile dropped into Pinned or Auto-sort:
    // the destination lane requires a live terminal, so the same drop is also
    // a launch request. Build the launch list before mutating local state.
    const launchNames = [];
    if (!sourceCard.isLive && (dstLane === 'pinned' || dstLane === 'auto')) {
      launchNames.push(sourceCard.name);
    }

    // Remove from source lane.
    const [card] = srcArr.splice(idx, 1);

    // Apply card stamp changes for cross-lane moves so the immediate render
    // reflects the new lane (e.g. shell tag still renders, color persists).
    const dstArr = state[dstLane];
    if (position && position.relative) {
      const targetIdx = dstArr.findIndex((c) => c.name === position.relative);
      const insertAt = targetIdx === -1
        ? dstArr.length
        : (position.before ? targetIdx : targetIdx + 1);
      dstArr.splice(insertAt, 0, card);
    } else {
      dstArr.push(card);
    }

    // Optimistic: flip the card's local isLive so the post-render
    // matches the user's destination lane. The next state push from the
    // extension is authoritative — if the launch fails for any reason,
    // it'll correct us. Better than rendering a "closed" badge on a card
    // that just initiated a launch.
    if (launchNames.length > 0) {
      card.isLive = true;
    }

    render();
    sendLayout(launchNames);
  }

  function sendLayout(launchNames) {
    vscode.postMessage({
      type: 'organizer:applyLayout',
      pinnedOrder: state.pinned.map((c) => c.name),
      // Auto-sort + closed-but-visible share config state — same flag combo,
      // runtime liveness is the only difference. Send them as one list.
      unpinnedNames: [...state.auto, ...state.closedVisible].map((c) => c.name),
      hiddenNames: state.hidden.map((c) => c.name),
      // v0.19 (#44) — names to launch as part of this drop. Provider runs
      // launches AFTER applyLayout so the destination lane's config flags
      // are set when the terminal opens.
      launchNames: Array.isArray(launchNames) ? launchNames : [],
    });
    setStatus(
      (launchNames && launchNames.length) ? 'Launching…' : 'Saved.',
      true,
    );
  }

  function setStatus(text, transient) {
    const el = document.getElementById('status');
    if (!el) return;
    el.textContent = text;
    if (transient) {
      setTimeout(() => {
        if (el.textContent === text) el.textContent = '';
      }, 1500);
    }
  }

  // Footer button: open the JSONC config in an editor.
  document.querySelector('button[data-action="openConfig"]')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'organizer:openConfig' });
  });

  function applyState(msg) {
    state = {
      pinned: Array.isArray(msg.lanes?.pinned) ? msg.lanes.pinned : [],
      auto: Array.isArray(msg.lanes?.auto) ? msg.lanes.auto : [],
      closedVisible: Array.isArray(msg.lanes?.closedVisible) ? msg.lanes.closedVisible : [],
      hidden: Array.isArray(msg.lanes?.hidden) ? msg.lanes.hidden : [],
    };
    render();
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || msg.type !== 'organizer:state') return;
    // Defer rebuilds while the user has a card grabbed — innerHTML='' on
    // the lane container would detach the dragged DOM node mid-gesture
    // and silently abort the HTML5 drag operation. dragend applies the
    // pending state once the drop completes.
    if (dragSrc) {
      pendingState = msg;
      return;
    }
    applyState(msg);
  });

  wireLaneContainers();
  // Render once with whatever's in the (initially empty) state, then ask for
  // the real picture. Avoids a flash of stale empty lanes.
  render();
  vscode.postMessage({ type: 'organizer:requestState' });
})();
