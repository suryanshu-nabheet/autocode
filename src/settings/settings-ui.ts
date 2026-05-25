/**
 * AutoCode settings webview markup — completion-focused, VS Code native tokens.
 */
export function getSettingsWebviewHtml(nonce: string): string {
  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>AutoCode</title>
  <style nonce="${nonce}">
    :root {
      --ac-brand: var(--vscode-button-background, #0e639c);
      --ac-brand-fg: var(--vscode-button-foreground, #fff);
      --ac-surface: var(--vscode-editor-background);
      --ac-panel: var(--vscode-sideBar-background, var(--ac-surface));
      --ac-border: var(--vscode-widget-border, color-mix(in srgb, var(--vscode-foreground) 12%, transparent));
      --ac-text: var(--vscode-foreground);
      --ac-muted: var(--vscode-descriptionForeground);
      --ac-input: var(--vscode-input-background);
      --ac-input-border: var(--vscode-input-border, var(--ac-border));
      --ac-focus: var(--vscode-focusBorder, var(--ac-brand));
      --ac-radius: 6px;
      --ac-space: 16px;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      font-size: 13px;
      line-height: 1.45;
      color: var(--ac-text);
      background: var(--ac-surface);
      min-height: 100vh;
    }

    .shell {
      display: grid;
      grid-template-columns: 220px 1fr;
      min-height: 100vh;
    }

    @media (max-width: 720px) {
      .shell { grid-template-columns: 1fr; }
      .sidebar { border-right: none; border-bottom: 1px solid var(--ac-border); }
      .sidebar nav { display: flex; gap: 4px; padding: 8px 12px 12px; overflow-x: auto; }
      .nav-btn { white-space: nowrap; padding: 8px 12px; }
    }

    .sidebar {
      background: var(--ac-panel);
      border-right: 1px solid var(--ac-border);
      padding: 24px 0;
    }

    .brand {
      padding: 0 20px 20px;
      font-size: 15px;
      font-weight: 600;
      letter-spacing: -0.02em;
    }

    .brand span {
      display: block;
      font-size: 11px;
      font-weight: 400;
      color: var(--ac-muted);
      margin-top: 4px;
    }

    .nav-btn {
      display: block;
      width: 100%;
      text-align: left;
      padding: 10px 20px;
      border: none;
      background: transparent;
      color: var(--ac-muted);
      font: inherit;
      font-size: 13px;
      cursor: pointer;
      border-left: 2px solid transparent;
    }

    .nav-btn[aria-current="page"] {
      color: var(--ac-text);
      font-weight: 600;
      background: color-mix(in srgb, var(--ac-brand) 10%, transparent);
      border-left-color: var(--ac-brand);
    }

    .nav-btn:focus-visible {
      outline: 1px solid var(--ac-focus);
      outline-offset: -1px;
    }

    .main { display: flex; flex-direction: column; min-width: 0; }

    .main-header {
      padding: 28px 32px 16px;
      border-bottom: 1px solid var(--ac-border);
    }

    .main-header h1 {
      font-size: 20px;
      font-weight: 600;
      letter-spacing: -0.02em;
    }

    .main-header p {
      margin-top: 4px;
      color: var(--ac-muted);
      font-size: 12px;
    }

    .main-body {
      flex: 1;
      overflow-y: auto;
      padding: 24px 32px 40px;
    }

    .page { display: none; max-width: 640px; }
    .page[data-visible="true"] { display: block; }

    .card {
      border: 1px solid var(--ac-border);
      border-radius: var(--ac-radius);
      margin-bottom: var(--ac-space);
      overflow: hidden;
    }

    .card-title {
      padding: 12px 16px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--ac-muted);
      background: color-mix(in srgb, var(--ac-panel) 50%, var(--ac-surface));
      border-bottom: 1px solid var(--ac-border);
    }

    .row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 16px;
      align-items: center;
      padding: 14px 16px;
      border-bottom: 1px solid var(--ac-border);
    }

    .row:last-child { border-bottom: none; }

    @media (max-width: 560px) {
      .row { grid-template-columns: 1fr; align-items: start; }
    }

    .row-label { font-weight: 500; font-size: 13px; }
    .row-hint { font-size: 12px; color: var(--ac-muted); margin-top: 2px; }

    .control { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; align-items: center; }

    .field {
      min-width: 200px;
      max-width: 100%;
      padding: 6px 10px;
      border-radius: 4px;
      border: 1px solid var(--ac-input-border);
      background: var(--ac-input);
      color: var(--ac-text);
      font: inherit;
      font-size: 13px;
    }

    .field:focus-visible {
      outline: 1px solid var(--ac-focus);
      border-color: var(--ac-focus);
    }

    .field-mono {
      font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
      font-size: 12px;
    }

    .seg {
      display: inline-flex;
      padding: 2px;
      gap: 2px;
      border-radius: var(--ac-radius);
      border: 1px solid var(--ac-border);
      background: var(--ac-input);
    }

    .seg button {
      border: none;
      background: transparent;
      color: var(--ac-muted);
      font: inherit;
      font-size: 12px;
      padding: 5px 10px;
      border-radius: 4px;
      cursor: pointer;
    }

    .seg button[aria-pressed="true"] {
      background: var(--ac-surface);
      color: var(--ac-text);
      font-weight: 600;
      box-shadow: 0 1px 2px rgba(0,0,0,0.08);
    }

    .seg button:focus-visible { outline: 1px solid var(--ac-focus); }

    .btn {
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      padding: 6px 14px;
      border-radius: 4px;
      cursor: pointer;
      border: 1px solid transparent;
    }

    .btn-primary {
      background: var(--ac-brand);
      color: var(--ac-brand-fg);
    }

    .btn-primary:focus-visible { outline: 2px solid var(--ac-focus); outline-offset: 2px; }

    .btn-ghost {
      background: transparent;
      color: var(--ac-text);
      border-color: var(--ac-border);
    }

    .btn-ghost:focus-visible { outline: 1px solid var(--ac-focus); }

    .switch {
      position: relative;
      width: 36px;
      height: 20px;
      flex-shrink: 0;
    }

    .switch input {
      position: absolute;
      opacity: 0;
      width: 0;
      height: 0;
    }

    .switch-ui {
      display: block;
      width: 100%;
      height: 100%;
      border-radius: 10px;
      background: color-mix(in srgb, var(--ac-muted) 35%, transparent);
      cursor: pointer;
      transition: background 0.15s ease;
    }

    .switch-ui::after {
      content: '';
      position: absolute;
      width: 14px;
      height: 14px;
      top: 3px;
      left: 3px;
      border-radius: 50%;
      background: var(--vscode-editor-background, #fff);
      transition: transform 0.15s ease;
    }

    .switch input:checked + .switch-ui { background: var(--ac-brand); }
    .switch input:checked + .switch-ui::after { transform: translateX(16px); }
    .switch input:focus-visible + .switch-ui { outline: 1px solid var(--ac-focus); }

    .models {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
      width: 100%;
      justify-content: flex-end;
    }

    .chip {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      padding: 4px 8px;
      border-radius: 4px;
      border: 1px solid var(--ac-border);
      background: var(--ac-input);
      color: var(--ac-muted);
      cursor: pointer;
    }

    .chip[aria-pressed="true"] {
      border-color: var(--ac-brand);
      background: color-mix(in srgb, var(--ac-brand) 18%, transparent);
      color: var(--ac-text);
    }

    .chip:focus-visible { outline: 1px solid var(--ac-focus); }

    .link {
      font-size: 11px;
      color: var(--ac-brand);
      background: none;
      border: none;
      cursor: pointer;
      font-family: inherit;
      text-decoration: underline;
      text-underline-offset: 2px;
    }

    .status {
      font-size: 12px;
      color: var(--ac-muted);
      min-height: 18px;
    }

    .hidden { display: none !important; }

    .toast-wrap {
      position: fixed;
      bottom: 16px;
      right: 16px;
      z-index: 100;
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-width: 320px;
    }

    .toast {
      padding: 10px 14px;
      border-radius: var(--ac-radius);
      font-size: 12px;
      border: 1px solid var(--ac-border);
      background: var(--vscode-notifications-background, var(--ac-panel));
      box-shadow: 0 4px 16px rgba(0,0,0,0.12);
    }

    .toast[data-kind="ok"] { border-left: 3px solid #2ea043; }
    .toast[data-kind="err"] { border-left: 3px solid #f85149; }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">AutoCode<span>Tab completion only</span></div>
      <nav>
        <button type="button" class="nav-btn" data-page="connection" aria-current="page">Connection</button>
        <button type="button" class="nav-btn" data-page="speed">Speed &amp; context</button>
      </nav>
    </aside>

    <div class="main">
      <header class="main-header">
        <h1 id="pageTitle">Connection</h1>
        <p id="pageDesc">Model provider and API credentials</p>
      </header>

      <div class="main-body">
        <section class="page" id="page-connection" data-visible="true">
          <div class="card">
            <div class="card-title">Provider</div>
            <div class="row">
              <div>
                <div class="row-label">Engine</div>
                <div class="row-hint">Local Ollama needs no API key</div>
              </div>
              <div class="control">
                <div class="seg" role="group" aria-label="Provider">
                  <button type="button" data-provider="ollama" aria-pressed="true">Ollama</button>
                  <button type="button" data-provider="openai" aria-pressed="false">OpenAI</button>
                  <button type="button" data-provider="anthropic" aria-pressed="false">Anthropic</button>
                  <button type="button" data-provider="custom" aria-pressed="false">Custom</button>
                </div>
              </div>
            </div>
            <div class="row" id="apiKeyRow">
              <div>
                <div class="row-label">API key</div>
                <div class="row-hint" id="apiKeyHint">Stored in VS Code secret storage</div>
              </div>
              <div class="control">
                <input type="password" class="field field-mono" id="apiKeyInput" placeholder="sk-…" autocomplete="off">
                <button type="button" class="btn btn-primary" id="saveKeyBtn">Save</button>
              </div>
            </div>
            <div class="row">
              <div>
                <div class="row-label">Endpoint</div>
                <div class="row-hint">API base URL</div>
              </div>
              <div class="control">
                <input type="text" class="field field-mono" id="endpointInput" placeholder="http://localhost:11434">
              </div>
            </div>
            <div class="row">
              <div>
                <div class="row-label">Model</div>
                <div class="row-hint" id="modelHint">Coder model recommended for tab completion</div>
              </div>
              <div class="control" style="flex-direction: column; align-items: stretch;">
                <input type="text" class="field field-mono" id="modelInput" placeholder="qwen2.5-coder:1.5b">
                <div id="ollamaModels" class="hidden">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;">
                    <span style="font-size:11px;color:var(--ac-muted);">Installed</span>
                    <button type="button" class="link" id="refreshModelsBtn">Refresh</button>
                  </div>
                  <div class="models" id="modelPillList"></div>
                </div>
              </div>
            </div>
            <div class="row">
              <div>
                <div class="row-label">Connection</div>
                <div class="row-hint status" id="connStatus">Not tested</div>
              </div>
              <div class="control">
                <button type="button" class="btn btn-ghost" id="testConnBtn">Test</button>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-title">Completion</div>
            <div class="row">
              <div>
                <div class="row-label">Enable tab completions</div>
                <div class="row-hint">Inline ghost text as you type</div>
              </div>
              <label class="switch">
                <input type="checkbox" id="toggleEnabled" data-key="enabled">
                <span class="switch-ui"></span>
              </label>
            </div>
            <div class="row">
              <div>
                <div class="row-label">Streaming</div>
                <div class="row-hint">Show tokens as they arrive</div>
              </div>
              <label class="switch">
                <input type="checkbox" id="toggleStreaming" data-key="streamingEnabled">
                <span class="switch-ui"></span>
              </label>
            </div>
          </div>
        </section>

        <section class="page" id="page-speed">
          <div class="card">
            <div class="card-title">Latency</div>
            <div class="row">
              <div>
                <div class="row-label">Trigger delay</div>
                <div class="row-hint">Ms after typing before requesting completion (lower = faster)</div>
              </div>
              <input type="number" class="field field-mono" id="debounceInput" min="40" max="800" step="10" style="width:88px;">
            </div>
            <div class="row">
              <div>
                <div class="row-label">Max lines per Tab</div>
                <div class="row-hint">How many lines one ghost suggestion can span (default 24)</div>
              </div>
              <input type="number" class="field field-mono" id="maxLinesInput" min="4" max="80" step="1" style="width:88px;">
            </div>
            <div class="row">
              <div>
                <div class="row-label">Max completion tokens</div>
                <div class="row-hint">Raise for longer blocks; lower for speed</div>
              </div>
              <input type="number" class="field field-mono" id="maxTokensInput" min="64" max="1024" step="32" style="width:88px;">
            </div>
            <div class="row">
              <div>
                <div class="row-label">Context budget</div>
                <div class="row-hint">Tokens of project context (imports, defs, related files)</div>
              </div>
              <input type="number" class="field field-mono" id="maxContextInput" min="2048" max="16384" step="512" style="width:96px;">
            </div>
          </div>

          <div class="card">
            <div class="card-title">Intelligence</div>
            <div class="row">
              <div>
                <div class="row-label">Prefetch next lines</div>
                <div class="row-hint">Warm completions for likely cursor positions</div>
              </div>
              <label class="switch">
                <input type="checkbox" id="togglePrefetch" data-key="prefetchEnabled">
                <span class="switch-ui"></span>
              </label>
            </div>
            <div class="row">
              <div>
                <div class="row-label">Completion cache</div>
                <div class="row-hint">Instant replay on the same line prefix</div>
              </div>
              <label class="switch">
                <input type="checkbox" id="toggleCache" data-key="cacheEnabled">
                <span class="switch-ui"></span>
              </label>
            </div>
            <div class="row">
              <div>
                <div class="row-label">Project style learning</div>
                <div class="row-hint">Indent, quotes, naming from your files</div>
              </div>
              <label class="switch">
                <input type="checkbox" id="toggleStyleLearn" data-key="styleLearnEnabled">
                <span class="switch-ui"></span>
              </label>
            </div>
            <div class="row">
              <div>
                <div class="row-label">Log level</div>
              </div>
              <select class="field" id="logLevelSelect" style="width:120px;">
                <option value="warn">Warning</option>
                <option value="info">Info</option>
                <option value="debug">Debug</option>
                <option value="error">Error</option>
              </select>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>

  <div class="toast-wrap" id="toastContainer"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let config = {};
    let availableModels = [];

    vscode.postMessage({ type: 'getConfig' });

    window.addEventListener('message', (e) => {
      const m = e.data;
      if (m.type === 'configUpdate') {
        config = m.config;
        availableModels = config.availableModels || [];
        render();
      }
      if (m.type === 'modelsFetched') {
        availableModels = m.models;
        renderModelChips();
      }
      if (m.type === 'saveResult') toast(m.success ? 'ok' : 'err', m.message);
      if (m.type === 'connectionTest') {
        document.getElementById('connStatus').textContent = m.message;
        toast(m.status === 'success' ? 'ok' : m.status === 'error' ? 'err' : 'info', m.message);
      }
    });

    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-btn').forEach((b) => b.removeAttribute('aria-current'));
        btn.setAttribute('aria-current', 'page');
        const id = btn.dataset.page;
        document.querySelectorAll('.page').forEach((p) => {
          p.dataset.visible = p.id === 'page-' + id ? 'true' : 'false';
        });
        const meta = {
          connection: ['Connection', 'Model provider and API credentials'],
          speed: ['Speed & context', 'Latency, cache, and agentic context budget'],
        };
        const [title, desc] = meta[id] || ['Settings', ''];
        document.getElementById('pageTitle').textContent = title;
        document.getElementById('pageDesc').textContent = desc;
      });
    });

    document.querySelectorAll('[data-provider]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const provider = btn.dataset.provider;
        vscode.postMessage({ type: 'saveConfig', key: 'provider', value: provider });
        if (provider === 'ollama') vscode.postMessage({ type: 'fetchModels' });
      });
    });

    document.getElementById('saveKeyBtn').addEventListener('click', () => {
      const key = document.getElementById('apiKeyInput').value;
      if (key) {
        vscode.postMessage({ type: 'saveApiKey', provider: config.provider, apiKey: key });
        document.getElementById('apiKeyInput').value = '';
      }
    });

    document.getElementById('testConnBtn').addEventListener('click', () => {
      document.getElementById('connStatus').textContent = 'Testing…';
      vscode.postMessage({ type: 'testConnection' });
    });

    document.getElementById('refreshModelsBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'fetchModels' });
    });

    document.querySelectorAll('.switch input, #logLevelSelect').forEach((el) => {
      el.addEventListener('change', () => {
        const key = el.dataset.key || 'logLevel';
        const value = el.dataset.key ? el.checked : el.value;
        vscode.postMessage({ type: 'saveConfig', key, value });
      });
    });

    const fields = {
      modelInput: { key: 'model', type: 'string' },
      endpointInput: { key: 'apiEndpoint', type: 'string' },
      debounceInput: { key: 'debounceMs', type: 'number' },
      maxTokensInput: { key: 'maxTokens', type: 'number' },
      maxLinesInput: { key: 'maxCompletionLines', type: 'number' },
      maxContextInput: { key: 'maxContextTokens', type: 'number' },
    };

    Object.entries(fields).forEach(([id, spec]) => {
      const el = document.getElementById(id);
      el.addEventListener('change', () => {
        const val = spec.type === 'number' ? parseInt(el.value, 10) : el.value;
        if (spec.type === 'number' && Number.isNaN(val)) return;
        vscode.postMessage({ type: 'saveConfig', key: spec.key, value: val });
      });
    });

    function render() {
      document.querySelectorAll('[data-provider]').forEach((btn) => {
        btn.setAttribute('aria-pressed', btn.dataset.provider === config.provider ? 'true' : 'false');
      });
      document.getElementById('apiKeyRow').classList.toggle('hidden', config.provider === 'ollama');
      document.getElementById('toggleEnabled').checked = !!config.enabled;
      document.getElementById('toggleStreaming').checked = config.streamingEnabled !== false;
      document.getElementById('togglePrefetch').checked = config.prefetchEnabled !== false;
      document.getElementById('toggleCache').checked = config.cacheEnabled !== false;
      document.getElementById('toggleStyleLearn').checked = config.styleLearnEnabled !== false;
      document.getElementById('modelInput').value = config.model || '';
      document.getElementById('endpointInput').value = config.apiEndpoint || '';
      document.getElementById('debounceInput').value = config.debounceMs ?? 80;
      document.getElementById('maxLinesInput').value = config.maxCompletionLines ?? 24;
      document.getElementById('maxTokensInput').value = config.maxTokens ?? 384;
      document.getElementById('maxContextInput').value = config.maxContextTokens ?? 6144;
      document.getElementById('logLevelSelect').value = config.logLevel || 'warn';
      document.getElementById('ollamaModels').classList.toggle('hidden', config.provider !== 'ollama');
      if (config.apiKeySet && config.apiKeyPreview) {
        document.getElementById('apiKeyHint').textContent = 'Saved: ' + config.apiKeyPreview;
      }
      renderModelChips();
    }

    function renderModelChips() {
      const list = document.getElementById('modelPillList');
      list.innerHTML = '';
      availableModels.forEach((m) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.textContent = m;
        chip.setAttribute('aria-pressed', config.model === m ? 'true' : 'false');
        chip.addEventListener('click', () => vscode.postMessage({ type: 'saveConfig', key: 'model', value: m }));
        list.appendChild(chip);
      });
      if (!availableModels.length && config.provider === 'ollama') {
        list.innerHTML = '<span style="font-size:11px;color:var(--ac-muted);">No models — start Ollama and refresh</span>';
      }
    }

    function toast(kind, message) {
      const wrap = document.getElementById('toastContainer');
      const el = document.createElement('div');
      el.className = 'toast';
      el.dataset.kind = kind;
      el.textContent = message;
      wrap.appendChild(el);
      setTimeout(() => el.remove(), 2800);
    }
  </script>
</body>
</html>`;
}
