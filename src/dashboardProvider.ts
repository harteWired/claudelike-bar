import * as vscode from 'vscode';
import * as path from 'path';
import { TileData, WebviewMessage, AudioPlayMessage, AudioAck } from './types';
import { soundsDir } from './claudePaths';

export class DashboardProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private extensionUri: vscode.Uri;
  // v0.12 — asWebviewUri() isn't free (string manipulation + URI allocation
  // per call). There are only ever two distinct sound filenames per config
  // lifetime; cache the resolved URI and clear on config reload.
  private soundUriCache = new Map<string, string>();
  // v0.12 — fires after the webview reports back on a play attempt. Only
  // consumed by the private __firePlayForTest command; production listeners
  // are none. Always-on so CI doesn't need a test-mode build.
  private onAudioAckEmitter = new vscode.EventEmitter<AudioAck>();
  readonly onAudioAck = this.onAudioAckEmitter.event;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'media'),
        // v0.12 — audio alerts load from ~/.claude/sounds/. Always included
        // even when audio is disabled so enabling it mid-session doesn't
        // require re-resolving the webview. Filenames are whitelisted to
        // [a-zA-Z0-9._-]+ in configManager so traversal isn't possible.
        vscode.Uri.file(soundsDir()),
      ],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    // Handle messages from webview. Audio acks are routed to a dedicated
    // emitter — they're internal to the audio pipeline, not a UI command
    // for the extension.ts dispatcher to handle.
    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      if (message?.type === 'audioPlayed') {
        this.onAudioAckEmitter.fire({ type: 'played', url: message.url });
        return;
      }
      if (message?.type === 'audioPlayError') {
        this.onAudioAckEmitter.fire({ type: 'error', url: message.url, reason: message.reason });
        return;
      }
      this.onMessage?.(message);
    });
  }

  onMessage?: (message: WebviewMessage) => void;

  updateTiles(tiles: TileData[], audioEnabled = false, sortMode: 'auto' | 'manual' = 'auto'): void {
    this.view?.webview.postMessage({ type: 'update', tiles, audioEnabled, sortMode });
  }

  /**
   * v0.12 — resolve a sound filename from `~/.claude/sounds/` to a webview
   * URI and post a play message. Silently no-ops when the sidebar hasn't
   * been resolved yet (first-session cold webview).
   */
  postPlay(filename: string, volume: number): void {
    if (!this.view) return;
    let url = this.soundUriCache.get(filename);
    if (!url) {
      const fileUri = vscode.Uri.file(path.join(soundsDir(), filename));
      url = this.view.webview.asWebviewUri(fileUri).toString();
      this.soundUriCache.set(filename, url);
    }
    const msg: AudioPlayMessage = {
      type: 'play',
      url,
      volume,
    };
    this.view.webview.postMessage(msg);
  }

  /**
   * Drop cached filename → webview URI mappings. Called from the config-reload
   * path so a user who edits `audio.sounds.*` gets their new file resolved
   * fresh rather than served the stale URI.
   */
  clearSoundUriCache(): void {
    this.soundUriCache.clear();
  }

  private getHtml(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.js'));
    const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'codicon.css'));
    const codiconFontUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'codicon.ttf'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}'; media-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">
    @font-face {
      font-family: "codicon";
      font-display: block;
      src: url("${codiconFontUri}") format("truetype");
    }
  </style>
  <link href="${codiconCssUri}" rel="stylesheet">
  <link href="${cssUri}" rel="stylesheet">
</head>
<body>
  <div id="tiles-container">
    <div class="empty-state">No terminals open</div>
  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
