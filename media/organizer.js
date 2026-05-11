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

  // closedVisible → auto is a no-op at the config layer (both lanes share
  // `pinned:false, hidden:false`; the only difference is runtime liveness).
  // Without this guard the drop appears to succeed then snaps back when the
  // next state push re-derives the lane from `liveNames` — see issue #38.
  function isDropAllowed(srcLane, dstLane) {
    if (!DROPPABLE[dstLane]) return false;
    if (srcLane === 'closedVisible' && dstLane === 'auto') return false;
    return true;
  }

  // Plain-language reason for a rejected drop — surfaced in the footer
  // status so the user knows *why* nothing happened (issue #41).
  function rejectionReason(srcLane, dstLane) {
    if (srcLane === 'closedVisible' && dstLane === 'auto') {
      return 'Auto-sort shows running tiles only — launch the tile to move it here.';
    }
    return null;
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
  // True while the footer shows a drop-rejection reason — cleared on
  // dragend if the drop didn't land somewhere successful (issue #41).
  let rejectionShown = false;

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

    if (card.isShell) {
      const tag = document.createElement('span');
      tag.className = 'shell-tag';
      tag.textContent = 'shell';
      el.appendChild(tag);
    }

    el.addEventListener('dragstart', (e) => {
      dragSrc = { name: card.name, lane };
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
      document.querySelectorAll('.cards.drag-over, .cards.drop-rejected')
        .forEach((c) => c.classList.remove('drag-over', 'drop-rejected'));
      // Clear a lingering rejection-reason status if the drop didn't land
      // somewhere successful (a successful drop replaces it with 'Saved.').
      if (rejectionShown) {
        setStatus('', false);
        rejectionShown = false;
      }
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
        if (!isDropAllowed(dragSrc.lane, key)) {
          // Visually flag the rejection but don't preventDefault — the drop
          // will be ignored by the browser since we never accept it. Covers
          // the closedVisible → auto no-op case (issue #38). Surface a
          // plain-language reason in the footer (issue #41).
          container.classList.add('drag-over', 'drop-rejected');
          const reason = rejectionReason(dragSrc.lane, key);
          if (reason) {
            setStatus(reason, false);
            rejectionShown = true;
          }
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        container.classList.add('drag-over');
        container.classList.remove('drop-rejected');
      });
      container.addEventListener('dragleave', (e) => {
        // Only clear when leaving the container (not when crossing into a
        // child card). relatedTarget is the element we're entering.
        if (e.relatedTarget && container.contains(e.relatedTarget)) return;
        container.classList.remove('drag-over', 'drop-rejected');
        // Clear the rejection status when the cursor leaves the rejected
        // lane — keeps the footer accurate as the user keeps dragging.
        if (rejectionShown && !isDropAllowed(dragSrc?.lane, key)) {
          setStatus('', false);
          rejectionShown = false;
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

    render();
    sendLayout();
  }

  function sendLayout() {
    vscode.postMessage({
      type: 'organizer:applyLayout',
      pinnedOrder: state.pinned.map((c) => c.name),
      // Auto-sort + closed-but-visible share config state — same flag combo,
      // runtime liveness is the only difference. Send them as one list.
      unpinnedNames: [...state.auto, ...state.closedVisible].map((c) => c.name),
      hiddenNames: state.hidden.map((c) => c.name),
    });
    setStatus('Saved.', true);
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
