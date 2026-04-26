// @ts-check
/// <reference lib="dom" />

const vscode = acquireVsCodeApi();
const container = document.getElementById('tiles-container');

let currentTiles = [];
let selectedIndex = -1;
let draggingId = null;
let suppressNextClick = false;
/** The tile element currently decorated with a drop-indicator class. */
let dropIndicatorEl = null;
/** v0.12 — most recent audio.enabled state from the extension host. Used to
 * label the tile context-menu toggle as "Mute Audio" / "Unmute Audio". */
let audioEnabled = false;
/** v0.13.1 — most recent sortMode from the extension host. Controls whether
 * the "Switch to auto sort" tile context-menu entry appears. */
let sortMode = 'auto';

// Handle messages from extension
window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'update') {
    diffUpdate(message.tiles);
    currentTiles = message.tiles;
    if (typeof message.audioEnabled === 'boolean') {
      audioEnabled = message.audioEnabled;
    }
    if (message.sortMode === 'auto' || message.sortMode === 'manual') {
      sortMode = message.sortMode;
    }
  } else if (message.type === 'play') {
    // v0.12 — play a sound via HTML5 audio. The extension has already
    // resolved the URL into a webview URI and validated the filename.
    // We post an ack back (`audioPlayed` or `audioPlayError`) so the
    // CI smoke test can assert autoplay didn't get blocked. Production
    // code ignores the acks.
    const url = message.url;
    try {
      const audio = new Audio(url);
      audio.volume = typeof message.volume === 'number' ? message.volume : 0.6;
      audio.play().then(() => {
        vscode.postMessage({ type: 'audioPlayed', url });
      }).catch((err) => {
        vscode.postMessage({
          type: 'audioPlayError',
          url,
          reason: String((err && err.message) || err),
        });
      });
    } catch (err) {
      // Constructor can throw on malformed URL.
      vscode.postMessage({
        type: 'audioPlayError',
        url,
        reason: String((err && err.message) || err),
      });
    }
  }
});

// Keyboard navigation
document.addEventListener('keydown', (e) => {
  const tiles = container.querySelectorAll('.tile');
  if (!tiles.length) return;

  if (e.key === 'ArrowDown' || e.key === 'j') {
    e.preventDefault();
    selectedIndex = Math.min(selectedIndex + 1, tiles.length - 1);
    tiles[selectedIndex].focus();
  } else if (e.key === 'ArrowUp' || e.key === 'k') {
    e.preventDefault();
    selectedIndex = Math.max(selectedIndex - 1, 0);
    tiles[selectedIndex].focus();
  } else if (e.key === 'Enter' && selectedIndex >= 0) {
    e.preventDefault();
    tiles[selectedIndex].click();
  }
});

/**
 * DOM-diffing update: only touch elements that actually changed.
 * Prevents flicker, preserves click targets, skips unnecessary animation replays.
 */
function diffUpdate(tiles) {
  if (!tiles || tiles.length === 0) {
    if (container.querySelector('.empty-state')) return;
    container.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = 'No terminals open<br><button class="add-project-btn">Set Up Projects</button>';
    empty.querySelector('.add-project-btn').addEventListener('click', () => {
      vscode.postMessage({ type: 'setupProjects' });
    });
    container.appendChild(empty);
    selectedIndex = -1;
    return;
  }

  // Remove empty state if present
  const emptyState = container.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  const existingEls = container.querySelectorAll('.tile');
  const existingById = new Map();
  existingEls.forEach((el) => existingById.set(el.dataset.id, el));

  const newIds = new Set(tiles.map((t) => String(t.id)));

  // Remove tiles that no longer exist
  for (const [id, el] of existingById) {
    if (!newIds.has(id)) {
      el.remove();
      existingById.delete(id);
    }
  }

  // Update or create tiles in order
  let previousEl = null;
  let previousPinned = false;
  let previousRegistered = false;
  tiles.forEach((tile, index) => {
    let el = existingById.get(String(tile.id));

    if (el) {
      // Update existing tile in-place
      patchTile(el, tile);
    } else {
      // Create new tile
      el = createTileEl(tile, index);
      container.appendChild(el);
      // Animate entry
      requestAnimationFrame(() => {
        el.classList.remove('entering');
        el.classList.add('visible');
      });
    }

    // v0.13.4 (#4) — first pinned tile gets a divider above it.
    // v0.13.4 (#15) — first registered tile gets its own dashed divider.
    const isPinned = tile.pinned === true;
    const isRegistered = tile.status === 'registered';
    el.classList.toggle('pinned-first', isPinned && !previousPinned && previousEl !== null);
    el.classList.toggle('registered-first', isRegistered && !previousRegistered && previousEl !== null);
    previousPinned = isPinned;
    previousRegistered = isRegistered;

    // Ensure correct order
    if (previousEl) {
      if (previousEl.nextElementSibling !== el) {
        previousEl.after(el);
      }
    } else if (container.firstElementChild !== el) {
      container.prepend(el);
    }
    previousEl = el;
  });
}

/**
 * Patch an existing tile DOM element with new data — no rebuild.
 */
function patchTile(el, tile) {
  // Active state
  el.classList.toggle('active', tile.isActive);

  // Status-specific tile classes (for dashed border, error color, etc.)
  el.classList.toggle('status-ignored', tile.status === 'ignored');
  el.classList.toggle('status-error', tile.status === 'error');
  el.classList.toggle('status-offline', tile.status === 'offline');
  el.classList.toggle('status-registered', tile.status === 'registered');
  el.classList.toggle('status-shell', tile.status === 'shell');

  // Theme color
  el.style.setProperty('--tile-color', tile.themeColor);

  // Display name (nickname from config, or terminal name)
  const nameEl = el.querySelector('.tile-name');
  const displayName = tile.displayName || tile.name;
  if (nameEl && nameEl.textContent !== displayName) {
    nameEl.textContent = displayName;
  }

  // Icon
  const iconEl = el.querySelector('.tile-icon');
  if (tile.icon) {
    const expectedClass = `tile-icon codicon codicon-${tile.icon}`;
    if (iconEl) {
      if (iconEl.className !== expectedClass) {
        iconEl.className = expectedClass;
      }
    } else {
      // Insert icon after the dot
      const dot = el.querySelector('.dot');
      if (dot) {
        const icon = document.createElement('span');
        icon.className = expectedClass;
        dot.after(icon);
      }
    }
  } else if (iconEl) {
    iconEl.remove();
  }

  // Status dot
  const dot = el.querySelector('.dot');
  if (dot) {
    dot.className = `dot ${tile.status === 'ignored' ? 'ignored' : tile.status}`;
  }

  // Time
  const timeEl = el.querySelector('.tile-time');
  const timeStr = tile.status !== 'idle' ? formatRelativeTime(tile.lastActivity) : '';
  if (timeEl) {
    if (timeStr) {
      timeEl.textContent = timeStr;
    } else {
      timeEl.textContent = '';
    }
  }

  // Context %
  const ctxEl = el.querySelector('.tile-ctx');
  if (tile.contextPercent !== undefined && tile.contextPercent > 0) {
    const ctxClass = tile.contextPercent >= tile.contextCrit ? 'ctx-crit' : tile.contextPercent >= tile.contextWarn ? 'ctx-warn' : '';
    if (ctxEl) {
      ctxEl.textContent = `ctx ${tile.contextPercent}%`;
      ctxEl.className = `tile-ctx ${ctxClass}`;
    } else {
      // Insert ctx badge after time
      const header = el.querySelector('.tile-header');
      if (header) {
        const badge = document.createElement('span');
        badge.className = `tile-ctx ${ctxClass}`;
        badge.textContent = `ctx ${tile.contextPercent}%`;
        header.appendChild(badge);
      }
    }
  } else if (ctxEl) {
    ctxEl.remove();
  }

  // Status text
  const statusEl = el.querySelector('.tile-status');
  if (statusEl) {
    const label = tile.statusLabel || tile.status;
    statusEl.textContent = label;
    const statusClass = tile.status === 'ignored' ? ' status-ignored'
      : tile.status === 'error' ? ' status-error'
      : '';
    statusEl.className = `tile-status${statusClass}`;
  }

  // Aria
  const ariaDisplayName = tile.displayName || tile.name;
  const label = tile.statusLabel || tile.status;
  el.setAttribute('aria-label', `${ariaDisplayName} — ${label}`);
}

/**
 * Create a new tile DOM element.
 */
function createTileEl(tile, index) {
  const el = document.createElement('div');
  const tileStatusClass = tile.status === 'ignored' ? ' status-ignored'
    : tile.status === 'error' ? ' status-error'
    : tile.status === 'offline' ? ' status-offline'
    : tile.status === 'registered' ? ' status-registered'
    : tile.status === 'shell' ? ' status-shell'
    : '';
  el.className = `tile entering${tile.isActive ? ' active' : ''}${tileStatusClass}`;
  el.style.setProperty('--tile-color', tile.themeColor);
  el.tabIndex = 0;
  el.dataset.id = String(tile.id);
  el.setAttribute('role', 'button');
  el.draggable = true;

  const displayName = tile.displayName || tile.name;
  const timeStr = formatRelativeTime(tile.lastActivity);
  const statusLabel = tile.statusLabel || tile.status;
  const dotClass = tile.status === 'ignored' ? 'ignored' : tile.status;

  const iconHtml = tile.icon
    ? `<span class="tile-icon codicon codicon-${escapeHtml(tile.icon)}"></span>`
    : '';

  let ctxHtml = '';
  if (tile.contextPercent !== undefined && tile.contextPercent > 0) {
    const ctxClass = tile.contextPercent >= tile.contextCrit ? 'ctx-crit' : tile.contextPercent >= tile.contextWarn ? 'ctx-warn' : '';
    ctxHtml = `<span class="tile-ctx ${ctxClass}">ctx ${tile.contextPercent}%</span>`;
  }

  el.innerHTML = `
    <div class="tile-header">
      <span class="dot ${dotClass}"></span>
      ${iconHtml}
      <span class="tile-name">${escapeHtml(displayName)}</span>
      ${tile.status !== 'idle' ? `<span class="tile-time">${timeStr}</span>` : '<span class="tile-time"></span>'}
      ${ctxHtml}
    </div>
    <div class="tile-status${tile.status === 'ignored' ? ' status-ignored' : tile.status === 'error' ? ' status-error' : ''}">${escapeHtml(statusLabel)}</div>
  `;

  el.setAttribute('aria-label', `${displayName} — ${statusLabel}`);

  el.addEventListener('click', () => {
    // Suppress click that immediately follows a drag
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    // v0.13.4 (#15) — registered (offline) tiles launch the project on
    // click instead of switching to a (nonexistent) terminal.
    if (tile.status === 'registered') {
      vscode.postMessage({ type: 'launchByName', name: tile.name });
    } else {
      vscode.postMessage({ type: 'switchTerminal', id: tile.id });
    }
  });

  el.addEventListener('contextmenu', (e) => {
    showContextMenu(e, tile.id);
  });

  el.addEventListener('focus', () => {
    selectedIndex = index;
  });

  // --- Drag and drop (reordering) ---
  el.addEventListener('dragstart', (e) => {
    draggingId = String(tile.id);
    el.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      // Firefox requires dataTransfer to be set for drag to fire
      e.dataTransfer.setData('text/plain', draggingId);
    }
  });

  el.addEventListener('dragend', () => {
    draggingId = null;
    el.classList.remove('dragging');
    clearDropIndicators();
    // Click event fires on mouseup after drag — suppress it so we don't
    // accidentally switch to the terminal we just dropped.
    suppressNextClick = true;
    setTimeout(() => { suppressNextClick = false; }, 100);
  });

  el.addEventListener('dragover', (e) => {
    if (!draggingId || draggingId === el.dataset.id) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const rect = el.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    setDropIndicator(el, before ? 'drop-before' : 'drop-after');
  });

  // No `dragleave` listener — setDropIndicator always clears the previous
  // target before marking the new one, so stale indicators aren't possible.
  // The old approach (querySelectorAll on every dragover frame) caused style
  // recalc + layout thrash at ~60fps for zero benefit.

  el.addEventListener('drop', (e) => {
    if (!draggingId || draggingId === el.dataset.id) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    clearDropIndicators();
    commitDrop(draggingId, el.dataset.id, before);
  });

  return el;
}

/** Move the drop-indicator decoration to `el`, clearing any previous target. */
function setDropIndicator(el, cls) {
  if (dropIndicatorEl && dropIndicatorEl !== el) {
    dropIndicatorEl.classList.remove('drop-before', 'drop-after');
  }
  if (dropIndicatorEl !== el) {
    dropIndicatorEl = el;
  } else {
    // Same element — clear stale side before re-adding the new one
    el.classList.remove('drop-before', 'drop-after');
  }
  el.classList.add(cls);
}

function clearDropIndicators() {
  if (dropIndicatorEl) {
    dropIndicatorEl.classList.remove('drop-before', 'drop-after');
    dropIndicatorEl = null;
  }
}

function commitDrop(draggedId, targetId, before) {
  const tileEls = Array.from(container.querySelectorAll('.tile'));
  const ids = tileEls.map((el) => el.dataset.id).filter((id) => id !== draggedId);
  const targetIndex = ids.indexOf(targetId);
  if (targetIndex === -1) return;
  const insertAt = before ? targetIndex : targetIndex + 1;
  ids.splice(insertAt, 0, draggedId);
  vscode.postMessage({
    type: 'reorderTiles',
    orderedIds: ids.map((id) => Number(id)),
  });
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return '';
  const now = Date.now();
  const diff = Math.floor((now - timestamp) / 1000);

  if (diff < 5) return 'now';
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Context menu ---

const SWATCH_COLORS = [
  { name: 'cyan', css: 'var(--vscode-terminal-ansiCyan)' },
  { name: 'green', css: 'var(--vscode-terminal-ansiGreen)' },
  { name: 'blue', css: 'var(--vscode-terminal-ansiBrightBlue)' },
  { name: 'magenta', css: 'var(--vscode-terminal-ansiMagenta)' },
  { name: 'yellow', css: 'var(--vscode-terminal-ansiYellow)' },
  { name: 'white', css: 'var(--vscode-terminal-ansiBrightWhite)' },
  { name: 'red', css: 'var(--vscode-terminal-ansiRed)' },
];

let activeMenu = null;

function showContextMenu(e, tileId) {
  e.preventDefault();
  e.stopPropagation();
  dismissContextMenu();

  const tile = currentTiles.find((t) => t.id === tileId);
  const isRegistered = tile?.status === 'registered';
  const isShell = tile?.status === 'shell';

  const menu = document.createElement('div');
  menu.className = 'context-menu';

  // v0.13.4 (#15) — registered (offline) tiles only get the launch
  // action. Mark as done / Pin / Kill / Set color / Clone don't apply to
  // a tile with no underlying terminal yet. The user can pin/color the
  // entry by editing the JSONC config directly until the terminal exists.
  if (isRegistered) {
    const launchItem = menuItem('\uD83D\uDE80', 'Launch this project', () => {
      vscode.postMessage({ type: 'launchByName', name: tile.name });
    });
    menu.appendChild(launchItem);
    document.body.appendChild(menu);
    positionAndShowMenu(menu, e);
    return;
  }

  // v0.16.0 (#25) — shell tiles skip Claude-specific items (Mark as done,
  // Mute Audio, Launch project). Pin / Color / Clone / Kill / Switch to
  // auto sort all still apply because they manage the bar and the VS
  // Code terminal, not Claude state.
  if (!isShell) {
    // Mark as done — silences judgement for inactive terminals
    const doneItem = menuItem('\u2713', 'Mark as done', () => {
      vscode.postMessage({ type: 'markDone', id: tileId });
    });
    menu.appendChild(doneItem);
  }

  // v0.13.4 (#4) — Pin / Unpin. Pinned tiles live in a fixed-position
  // zone at the bottom of the bar regardless of sortMode. Label flips
  // based on current state. (`tile` was looked up at the top for the
  // registered-tile check; reuse it.)
  const isPinned = tile?.pinned === true;
  const pinIcon = isPinned ? '\uD83D\uDCCD' : '\uD83D\uDCCC'; // 📍 / 📌
  const pinLabel = isPinned ? 'Unpin tile' : 'Pin tile';
  const pinItem = menuItem(pinIcon, pinLabel, () => {
    vscode.postMessage({ type: 'setPinned', id: tileId, pinned: !isPinned });
  });
  menu.appendChild(pinItem);

  // v0.12 — Mute / Unmute audio + Launch another project. Both are
  // Claude-workflow items — skip them on shell tiles.
  if (!isShell) {
    const audioIcon = audioEnabled ? '\uD83D\uDD07' : '\uD83D\uDD0A'; // 🔇 / 🔊
    const audioLabel = audioEnabled ? 'Mute Audio' : 'Unmute Audio';
    const audioItem = menuItem(audioIcon, audioLabel, () => {
      vscode.postMessage({ type: 'toggleAudio' });
    });
    menu.appendChild(audioItem);

    // v0.13 — launch another registered project. Workflow action (not
    // per-tile state), so it sits below Mute/Unmute and above the
    // separator before Clone Terminal.
    const launchItem = menuItem('\uD83D\uDE80', 'Launch another project…', () => {
      vscode.postMessage({ type: 'launchProject' });
    });
    menu.appendChild(launchItem);
  }

  // v0.13.1 — "Switch to auto sort" only appears when we're in manual
  // mode. In auto mode the option is a no-op, so we omit it rather than
  // gray-out — keeps the menu tight.
  if (sortMode === 'manual') {
    const autoSortItem = menuItem('\u21C5', 'Switch to auto sort', () => {
      vscode.postMessage({ type: 'setSortMode', mode: 'auto' });
    });
    menu.appendChild(autoSortItem);
  }

  // Separator
  menu.appendChild(menuSeparator());

  // Clone terminal
  const cloneItem = menuItem('\u2750', 'Clone terminal', () => {
    vscode.postMessage({ type: 'cloneTerminal', id: tileId });
  });
  menu.appendChild(cloneItem);

  // Separator
  menu.appendChild(menuSeparator());

  // Set color — inline swatches
  const colorLabel = document.createElement('div');
  colorLabel.className = 'context-menu-item';
  colorLabel.style.cursor = 'default';
  colorLabel.style.opacity = '0.7';
  colorLabel.style.fontSize = '11px';
  colorLabel.innerHTML = '<span class="icon">\uD83C\uDFA8</span> Set color';
  menu.appendChild(colorLabel);

  const picker = document.createElement('div');
  picker.className = 'color-picker';
  for (const color of SWATCH_COLORS) {
    const swatch = document.createElement('div');
    swatch.className = 'color-swatch';
    swatch.style.background = color.css;
    swatch.title = color.name;
    swatch.addEventListener('click', () => {
      vscode.postMessage({ type: 'setColor', id: tileId, color: color.name });
      dismissContextMenu();
    });
    picker.appendChild(swatch);
  }
  // v0.13.2 (#10) — native color picker swatch. Same dimensions as the
  // ANSI swatches; opens the OS color picker on click. Posts the hex value
  // through the existing setColor handler — ConfigManager already accepts
  // any CSS color via VALID_CSS_COLOR (added in v0.11.4 for #1).
  const customSwatch = document.createElement('input');
  customSwatch.type = 'color';
  customSwatch.className = 'color-swatch color-swatch-custom';
  customSwatch.title = 'Custom color…';
  customSwatch.value = '#7dcfff'; // sensible starting hue
  customSwatch.addEventListener('change', () => {
    vscode.postMessage({ type: 'setColor', id: tileId, color: customSwatch.value });
    dismissContextMenu();
  });
  picker.appendChild(customSwatch);
  menu.appendChild(picker);

  // Reset color
  const resetItem = menuItem('\u21BA', 'Reset to default', () => {
    vscode.postMessage({ type: 'setColor', id: tileId, color: null });
  });
  resetItem.style.fontSize = '11px';
  resetItem.style.opacity = '0.7';
  menu.appendChild(resetItem);

  // Separator
  menu.appendChild(menuSeparator());

  // Kill terminal
  const killItem = menuItem('\u2715', 'Kill terminal', () => {
    vscode.postMessage({ type: 'killTerminal', id: tileId });
  });
  killItem.classList.add('destructive');
  menu.appendChild(killItem);

  // Position
  document.body.appendChild(menu);
  positionAndShowMenu(menu, e);
}

/** Position the context menu inside the viewport and assign as active. */
function positionAndShowMenu(menu, e) {
  const rect = menu.getBoundingClientRect();
  let x = e.clientX;
  let y = e.clientY;
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  activeMenu = menu;
}

function menuItem(icon, label, onClick) {
  const item = document.createElement('div');
  item.className = 'context-menu-item';
  item.innerHTML = `<span class="icon">${icon}</span> ${escapeHtml(label)}`;
  item.addEventListener('click', () => {
    onClick();
    dismissContextMenu();
  });
  return item;
}

function menuSeparator() {
  const sep = document.createElement('div');
  sep.className = 'context-menu-separator';
  return sep;
}

function dismissContextMenu() {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
}

// Dismiss on click outside or Escape
document.addEventListener('click', dismissContextMenu);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') dismissContextMenu();
});
