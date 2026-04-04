// @ts-check
/// <reference lib="dom" />

const vscode = acquireVsCodeApi();
const container = document.getElementById('tiles-container');

const STATUS_LABELS = {
  idle: 'Idle',
  working: 'Working',
  waiting: 'Waiting for input',
  done: 'Done',
};

let currentTiles = [];
let selectedIndex = -1;

// Handle messages from extension
window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'update') {
    currentTiles = message.tiles;
    render(message.tiles);
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

function render(tiles) {
  if (!tiles || tiles.length === 0) {
    container.innerHTML = '<div class="empty-state">No terminals open</div>';
    selectedIndex = -1;
    return;
  }

  // Build new HTML
  const fragment = document.createDocumentFragment();

  tiles.forEach((tile, index) => {
    const el = document.createElement('div');
    el.className = `tile entering${tile.isActive ? ' active' : ''}`;
    el.style.setProperty('--tile-color', tile.themeColor);
    el.tabIndex = 0;
    el.dataset.name = tile.name;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `${tile.name} — ${STATUS_LABELS[tile.status] || tile.status}`);

    const timeStr = formatRelativeTime(tile.lastActivity);

    el.innerHTML = `
      <div class="tile-header">
        <span class="dot ${tile.status}"></span>
        <span class="tile-name">${escapeHtml(tile.name)}</span>
        ${tile.status !== 'idle' ? `<span class="tile-time">${timeStr}</span>` : ''}
      </div>
      <div class="tile-status">${STATUS_LABELS[tile.status] || tile.status}</div>
    `;

    el.addEventListener('click', () => {
      vscode.postMessage({ type: 'switchTerminal', name: tile.name });
    });

    el.addEventListener('focus', () => {
      selectedIndex = index;
    });

    fragment.appendChild(el);
  });

  container.innerHTML = '';
  container.appendChild(fragment);

  // Trigger enter animation
  requestAnimationFrame(() => {
    const els = container.querySelectorAll('.tile');
    els.forEach((el, i) => {
      setTimeout(() => {
        el.classList.remove('entering');
        el.classList.add('visible');
      }, i * 30);
    });
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
