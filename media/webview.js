// @ts-check
/// <reference lib="dom" />

const vscode = acquireVsCodeApi();
const container = document.getElementById('tiles-container');

const STATUS_LABELS = {
  idle: 'Idle',
  working: 'Working',
  waiting: 'Waiting for input',
  done: 'Done',
  ignored: '', // uses custom ignoredText
};

let currentTiles = [];
let selectedIndex = -1;

// Handle messages from extension
window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'update') {
    diffUpdate(message.tiles);
    currentTiles = message.tiles;
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
    if (container.querySelector('.empty-state')) return; // already showing empty
    container.innerHTML = '<div class="empty-state">No terminals open</div>';
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

  // Ignored tile class (for dashed border)
  el.classList.toggle('status-ignored', tile.status === 'ignored');

  // Theme color
  el.style.setProperty('--tile-color', tile.themeColor);

  // Display name (nickname from config, or terminal name)
  const nameEl = el.querySelector('.tile-name');
  const displayName = tile.displayName || tile.name;
  if (nameEl && nameEl.textContent !== displayName) {
    nameEl.textContent = displayName;
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
    const ctxClass = tile.contextPercent >= 80 ? 'ctx-crit' : tile.contextPercent >= 60 ? 'ctx-warn' : '';
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
    const label = tile.status === 'ignored'
      ? (tile.ignoredText || 'Being ignored :(')
      : (STATUS_LABELS[tile.status] || tile.status);
    statusEl.textContent = label;
    statusEl.className = `tile-status${tile.status === 'ignored' ? ' status-ignored' : ''}`;
  }

  // Aria
  const ariaDisplayName = tile.displayName || tile.name;
  const label = tile.status === 'ignored'
    ? tile.ignoredText || 'Being ignored'
    : (STATUS_LABELS[tile.status] || tile.status);
  el.setAttribute('aria-label', `${ariaDisplayName} — ${label}`);
}

/**
 * Create a new tile DOM element.
 */
function createTileEl(tile, index) {
  const el = document.createElement('div');
  el.className = `tile entering${tile.isActive ? ' active' : ''}${tile.status === 'ignored' ? ' status-ignored' : ''}`;
  el.style.setProperty('--tile-color', tile.themeColor);
  el.tabIndex = 0;
  el.dataset.id = String(tile.id);
  el.setAttribute('role', 'button');

  const displayName = tile.displayName || tile.name;
  const timeStr = formatRelativeTime(tile.lastActivity);
  const statusLabel = tile.status === 'ignored'
    ? (tile.ignoredText || 'Being ignored :(')
    : (STATUS_LABELS[tile.status] || tile.status);
  const dotClass = tile.status === 'ignored' ? 'ignored' : tile.status;

  let ctxHtml = '';
  if (tile.contextPercent !== undefined && tile.contextPercent > 0) {
    const ctxClass = tile.contextPercent >= 80 ? 'ctx-crit' : tile.contextPercent >= 60 ? 'ctx-warn' : '';
    ctxHtml = `<span class="tile-ctx ${ctxClass}">ctx ${tile.contextPercent}%</span>`;
  }

  el.innerHTML = `
    <div class="tile-header">
      <span class="dot ${dotClass}"></span>
      <span class="tile-name">${escapeHtml(displayName)}</span>
      ${tile.status !== 'idle' ? `<span class="tile-time">${timeStr}</span>` : '<span class="tile-time"></span>'}
      ${ctxHtml}
    </div>
    <div class="tile-status${tile.status === 'ignored' ? ' status-ignored' : ''}">${statusLabel}</div>
  `;

  el.setAttribute('aria-label', `${displayName} — ${statusLabel}`);

  el.addEventListener('click', () => {
    vscode.postMessage({ type: 'switchTerminal', id: tile.id });
  });

  el.addEventListener('contextmenu', (e) => {
    showContextMenu(e, tile.id);
  });

  el.addEventListener('focus', () => {
    selectedIndex = index;
  });

  return el;
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

  const menu = document.createElement('div');
  menu.className = 'context-menu';

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
