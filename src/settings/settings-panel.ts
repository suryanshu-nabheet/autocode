/**
 * AutoCode Settings Panel
 *
 * Multi-page settings interface with sidebar navigation.
 * Design: Brutalist-refined — geometric forms, high contrast, intentional hierarchy.
 */

import * as vscode from 'vscode';
import { ConfigManager } from '../core/config';
import { Logger } from '../core/logger';
import { ModelLayer } from '../models/model-layer';

type PageId = 'general' | 'models' | 'performance' | 'advanced';

interface NavItem {
  id: PageId;
  label: string;
  icon: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'general', label: 'General', icon: 'settings' },
  { id: 'models', label: 'Models', icon: 'circuit-board' },
  { id: 'performance', label: 'Performance', icon: 'pulse' },
  { id: 'advanced', label: 'Advanced', icon: 'terminal' },
];

export class SettingsPanel implements vscode.Disposable {
  public static currentPanel: SettingsPanel | undefined;
  private static readonly viewType = 'autocode.settings';

  private readonly panel: vscode.WebviewPanel;
  private readonly config: ConfigManager;
  private readonly modelLayer: ModelLayer;
  private readonly logger: Logger;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    _extensionUri: vscode.Uri,
    modelLayer: ModelLayer
  ) {
    this.panel = panel;
    this.config = ConfigManager.getInstance();
    this.modelLayer = modelLayer;
    this.logger = Logger.getInstance();

    this.panel.webview.html = this.getWebviewContent();

    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );

    this.disposables.push(
      this.config.onConfigChange(async () => {
        this.panel.webview.postMessage({
          type: 'configUpdate',
          config: await this.getSafeConfig(),
        });
      })
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  public static createOrShow(extensionUri: vscode.Uri, modelLayer: ModelLayer): void {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (SettingsPanel.currentPanel) {
      SettingsPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      SettingsPanel.viewType,
      'AutoCode Settings',
      column || vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
    );

    SettingsPanel.currentPanel = new SettingsPanel(panel, extensionUri, modelLayer);
  }

  private async handleMessage(message: any): Promise<void> {
    switch (message.type) {
      case 'getConfig':
        this.panel.webview.postMessage({
          type: 'configUpdate',
          config: await this.getSafeConfig(),
        });
        break;

      case 'saveConfig':
        await this.saveConfig(message.key, message.value);
        break;

      case 'saveApiKey':
        await this.saveApiKey(message.provider, message.apiKey);
        break;

      case 'testConnection':
        await this.testConnection();
        break;
      
      case 'fetchModels':
        await this.fetchModels();
        break;

      case 'openOutputLog':
        Logger.getInstance().show();
        break;
    }
  }

  private async fetchModels(): Promise<void> {
    const models = await this.modelLayer.fetchModels();
    this.panel.webview.postMessage({
        type: 'modelsFetched',
        models
    });
  }

  private async saveConfig(key: string, value: any): Promise<void> {
    try {
      await vscode.workspace
        .getConfiguration('autocode')
        .update(key, value, vscode.ConfigurationTarget.Global);

      this.panel.webview.postMessage({
        type: 'saveResult',
        success: true,
        key,
        message: `${key} updated`,
      });

      this.logger.info(`Config updated: ${key} = ${typeof value === 'string' && key === 'apiKey' ? '***' : value}`);
    } catch (err) {
      this.panel.webview.postMessage({
        type: 'saveResult',
        success: false,
        key,
        message: `Failed to save ${key}`,
      });
      this.logger.error(`Failed to save config: ${key}`, err);
    }
  }

  private async saveApiKey(provider: string, apiKey: string): Promise<void> {
    try {
      await this.config.setApiKey(apiKey);

      if (provider) {
        await vscode.workspace
          .getConfiguration('autocode')
          .update('provider', provider, vscode.ConfigurationTarget.Global);
      }

      this.panel.webview.postMessage({
        type: 'saveResult',
        success: true,
        key: 'apiKey',
        message: 'API key saved securely',
      });

      this.logger.info(`API key updated for provider: ${provider}`);
    } catch (err) {
      this.panel.webview.postMessage({
        type: 'saveResult',
        success: false,
        key: 'apiKey',
        message: 'Failed to save API key',
      });
    }
  }

  private async testConnection(): Promise<void> {
    this.panel.webview.postMessage({
      type: 'connectionTest',
      status: 'testing',
      message: 'Testing connection...',
    });

    try {
      const config = this.config.get();
      const apiKey = await this.config.getApiKey();
      let endpoint = '';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };

      switch (config.provider) {
        case 'openai':
          endpoint = (config.apiEndpoint || 'https://api.openai.com/v1') + '/models';
          headers['Authorization'] = `Bearer ${apiKey}`;
          break;
        case 'anthropic':
          endpoint = (config.apiEndpoint || 'https://api.anthropic.com/v1') + '/messages';
          headers['x-api-key'] = apiKey;
          headers['anthropic-version'] = '2023-06-01';
          break;
        case 'ollama':
          endpoint = (config.apiEndpoint || 'http://localhost:11434') + '/api/tags';
          break;
        case 'custom':
          endpoint = config.apiEndpoint + '/models';
          headers['Authorization'] = `Bearer ${apiKey}`;
          break;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(endpoint, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok) {
        this.panel.webview.postMessage({
          type: 'connectionTest',
          status: 'success',
          message: `Connected to ${config.provider} (${response.status})`,
        });
      } else {
        this.panel.webview.postMessage({
          type: 'connectionTest',
          status: 'error',
          message: `Failed: ${response.status} ${response.statusText}`,
        });
      }
    } catch (err: any) {
      const message = err.name === 'AbortError'
        ? 'Connection timed out (10s)'
        : err.message || 'Unknown error';

      this.panel.webview.postMessage({
        type: 'connectionTest',
        status: 'error',
        message: `Failed: ${message}`,
      });
    }
  }

  private async getSafeConfig(): Promise<Record<string, any>> {
    const config = this.config.get();
    const apiKey = await this.config.getApiKey();
    const availableModels = config.provider === 'ollama' ? await this.modelLayer.fetchModels() : [];
    
    return {
      enabled: config.enabled,
      provider: config.provider,
      model: config.model,
      apiKeySet: !!apiKey,
      apiKeyPreview: apiKey
        ? apiKey.substring(0, 6) + '••••' + apiKey.substring(apiKey.length - 4)
        : '',
      apiEndpoint: config.apiEndpoint,
      availableModels,
      maxContextTokens: config.maxContextTokens,
      debounceMs: config.debounceMs,
      prefetchEnabled: config.prefetchEnabled,
      maxCompletionLines: config.maxCompletionLines,
      streamingEnabled: config.streamingEnabled,
      cacheEnabled: config.cacheEnabled,
      cacheTTLSeconds: config.cacheTTLSeconds,
      styleLearnEnabled: config.styleLearnEnabled,
      logLevel: config.logLevel,
      maxTokens: config.maxTokens,
    };
  }

  private getWebviewContent(): string {
    const nonce = getNonce();

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>AutoCode Settings</title>
  <style nonce="${nonce}">
    :root {
      --accent: #0078d4;
      --accent-hover: #106ebe;
      --bg: var(--vscode-editor-background);
      --bg-subtle: var(--vscode-sideBar-background, var(--bg));
      --border: var(--vscode-widget-border, rgba(128,128,128,0.15));
      --text: var(--vscode-editor-foreground);
      --text-muted: var(--vscode-descriptionForeground);
      --text-subtle: var(--vscode-disabledForeground);
      --success: #2ea043;
      --error: #f85149;
      --input-bg: var(--vscode-input-background, rgba(0,0,0,0.1));
      --input-border: var(--vscode-input-border, var(--border));
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      font-size: 13px;
      color: var(--text);
      background: var(--bg);
      line-height: 1.5;
      overflow: hidden;
    }

    .app { display: flex; height: 100vh; }

    /* ── Sidebar ── */
    .sidebar {
      width: 200px;
      min-width: 200px;
      background: var(--bg-subtle);
      border-right: 1px solid var(--border);
      padding: 24px 0;
      display: flex;
      flex-direction: column;
    }

    .nav-header { padding: 0 20px 20px; }

    .nav-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: var(--text-muted);
    }

    .nav-item {
      padding: 9px 20px;
      cursor: pointer;
      font-size: 13px;
      color: var(--text-muted);
      position: relative;
      user-select: none;
    }

    .nav-item:hover { color: var(--text); background: rgba(128,128,128,0.06); }

    .nav-item.active {
      color: var(--text);
      font-weight: 600;
      background: rgba(0, 120, 212, 0.08);
    }

    .nav-item.active::before {
      content: '';
      position: absolute;
      left: 0; top: 0; bottom: 0;
      width: 2px;
      background: var(--accent);
    }

    /* ── Main ── */
    .main {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .header { padding: 32px 40px 20px; }

    .header h1 {
      font-size: 22px;
      font-weight: 600;
      letter-spacing: -0.3px;
      margin-bottom: 2px;
    }

    .header p { font-size: 13px; color: var(--text-muted); }

    .content {
      flex: 1;
      overflow-y: auto;
      padding: 0 40px 48px;
      scrollbar-width: thin;
      scrollbar-color: var(--border) transparent;
    }

    .page { display: none; max-width: 720px; }
    .page.active { display: block; }

    /* ── Sections ── */
    .section { margin-bottom: 36px; }

    .section-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-muted);
      margin-bottom: 4px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--border);
    }

    /* ── Settings Rows ── */
    .setting-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 0;
      border-bottom: 1px solid var(--border);
      gap: 24px;
    }

    .setting-row:last-child { border-bottom: none; }

    .setting-info { flex: 1; min-width: 0; }

    .setting-label {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      display: block;
      margin-bottom: 2px;
    }

    .setting-desc {
      font-size: 12px;
      color: var(--text-muted);
      display: block;
      line-height: 1.4;
    }

    .setting-control {
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
    }

    /* ── Toggle Switch ── */
    .toggle { position: relative; width: 40px; height: 22px; }
    .toggle input { opacity: 0; width: 0; height: 0; position: absolute; }

    .toggle-track {
      position: absolute;
      inset: 0;
      background: var(--text-subtle);
      border-radius: 11px;
      cursor: pointer;
      opacity: 0.5;
      transition: background 0.2s, opacity 0.2s;
    }

    .toggle-thumb {
      position: absolute;
      width: 16px; height: 16px;
      left: 3px; top: 3px;
      background: #fff;
      border-radius: 50%;
      transition: transform 0.2s;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
    }

    .toggle input:checked + .toggle-track { background: var(--accent); opacity: 1; }
    .toggle input:checked + .toggle-track .toggle-thumb { transform: translateX(18px); }

    /* ── Provider Pills ── */
    .pill-group {
      display: flex;
      gap: 2px;
      background: var(--input-bg);
      padding: 3px;
      border-radius: 6px;
      border: 1px solid var(--border);
    }

    .pill {
      padding: 5px 14px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      color: var(--text-muted);
      border: none;
      background: transparent;
      font-family: inherit;
    }

    .pill:hover { color: var(--text); }

    .pill.active {
      background: var(--bg);
      color: var(--text);
      font-weight: 600;
      box-shadow: 0 1px 3px rgba(0,0,0,0.12);
    }

    /* ── Inputs ── */
    .input {
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 13px;
      color: var(--text);
      font-family: inherit;
      outline: none;
      min-width: 280px;
    }

    .input:focus { border-color: var(--accent); }

    select.input { cursor: pointer; }

    .input-mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }

    /* ── Model Pills ── */
    .model-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 10px;
      max-width: 360px;
      justify-content: flex-end;
    }

    .model-pill {
      padding: 3px 10px;
      border-radius: 3px;
      background: var(--input-bg);
      border: 1px solid var(--border);
      font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
      cursor: pointer;
      color: var(--text-muted);
    }

    .model-pill:hover { border-color: var(--accent); color: var(--text); }

    .model-pill.active {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }

    .refresh-btn {
      font-size: 11px;
      color: var(--accent);
      cursor: pointer;
      background: none;
      border: none;
      font-family: inherit;
      text-decoration: none;
    }

    .refresh-btn:hover { text-decoration: underline; }

    /* ── Buttons ── */
    .btn {
      padding: 6px 16px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      font-family: inherit;
    }

    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover { background: var(--accent-hover); }

    .btn-secondary {
      background: transparent;
      color: var(--text);
      border: 1px solid var(--border);
    }

    .btn-secondary:hover { background: rgba(128,128,128,0.08); }

    /* ── Toast ── */
    .toast-container {
      position: fixed;
      bottom: 24px; right: 24px;
      z-index: 1000;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .toast {
      padding: 10px 16px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      background: var(--vscode-notifications-background, var(--bg-subtle));
      color: var(--text);
      border: 1px solid var(--border);
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      animation: toastIn 0.2s ease-out;
    }

    @keyframes toastIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .toast.success { border-left: 3px solid var(--success); }
    .toast.error { border-left: 3px solid var(--error); }

    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="nav-header">
        <div class="nav-title">AutoCode</div>
      </div>
      <nav>
        <div class="nav-item active" data-page="general">General</div>
        <div class="nav-item" data-page="models">Models</div>
        <div class="nav-item" data-page="performance">Performance</div>
        <div class="nav-item" data-page="advanced">Advanced</div>
      </nav>
    </aside>

    <main class="main">
      <header class="header">
        <h1 id="pageTitle">General</h1>
        <p id="pageDesc">Configure provider and core services</p>
      </header>

      <div class="content">
        <!-- General Page -->
        <div class="page active" id="page-general">
          <div class="section">
            <div class="section-title">Connectivity</div>
            
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">AI Provider</span>
                <span class="setting-desc">Choose your intelligence engine</span>
              </div>
              <div class="setting-control">
                <div class="pill-group">
                  <button class="pill active" data-provider="openai">OpenAI</button>
                  <button class="pill" data-provider="anthropic">Anthropic</button>
                  <button class="pill" data-provider="ollama">Ollama</button>
                  <button class="pill" data-provider="custom">Custom</button>
                </div>
              </div>
            </div>

            <div class="setting-row" id="apiKeyRow">
              <div class="setting-info">
                <span class="setting-label">API Key</span>
                <span class="setting-desc" id="apiKeyDesc">Stored securely in system keychain</span>
              </div>
              <div class="setting-control">
                <div style="display: flex; gap: 8px;">
                  <input type="password" class="input input-mono" id="apiKeyInput" placeholder="Enter key..." style="min-width: 240px;">
                  <button class="btn btn-primary" id="saveKeyBtn">Save</button>
                </div>
              </div>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Connection Status</span>
                <span class="setting-desc">Verify your current configuration</span>
              </div>
              <div class="setting-control">
                <button class="btn btn-secondary" id="testConnBtn">Test Connection</button>
              </div>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Engine Control</div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Autonomous Mode</span>
                <span class="setting-desc">Enable real-time code generation</span>
              </div>
              <div class="setting-control">
                <label class="toggle">
                  <input type="checkbox" id="toggleEnabled" data-key="enabled">
                  <span class="toggle-track"><span class="toggle-thumb"></span></span>
                </label>
              </div>
            </div>
          </div>
        </div>

        <!-- Models Page -->
        <div class="page" id="page-models">
          <div class="section">
            <div class="section-title">Model Intelligence</div>
            
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Model Selection</span>
                <span class="setting-desc" id="modelSelectionDesc">Specify the model architecture to use</span>
              </div>
              <div class="setting-control">
                <input type="text" class="input input-mono" id="modelInput" placeholder="e.g. gpt-4o">
                
                <!-- Ollama specific model list -->
                <div id="ollamaModelContainer" class="hidden">
                  <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; margin-top: 8px;">
                    <span style="font-size: 11px; color: var(--text-muted);">Detected Models:</span>
                    <button class="refresh-btn" id="refreshModelsBtn">Refresh</button>
                  </div>
                  <div id="modelPillList" class="model-list">
                    <!-- Models will be injected here -->
                  </div>
                </div>
              </div>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">API Endpoint</span>
                <span class="setting-desc">Override target server URL</span>
              </div>
              <div class="setting-control">
                <input type="text" class="input input-mono" id="endpointInput" placeholder="http://localhost:11434">
              </div>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Streaming</div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Zero-Latency Streaming</span>
                <span class="setting-desc">Enable sub-millisecond ghost text updates</span>
              </div>
              <div class="setting-control">
                <label class="toggle">
                  <input type="checkbox" id="toggleStreaming" data-key="streamingEnabled">
                  <span class="toggle-track"><span class="toggle-thumb"></span></span>
                </label>
              </div>
            </div>
          </div>
        </div>

        <!-- Performance Page -->
        <div class="page" id="page-performance">
          <div class="section">
            <div class="section-title">Response Tuning</div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Debounce Delay</span>
                <span class="setting-desc">Milliseconds to wait after typing before triggering AI (lower = faster, but more requests)</span>
              </div>
              <div class="setting-control">
                <input type="number" class="input input-mono" id="debounceInput" style="min-width: 100px; width: 100px;" min="50" max="2000" step="50">
              </div>
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Max Tokens per Completion</span>
                <span class="setting-desc">Token budget for each suggestion (lower = faster responses, higher = longer code blocks)</span>
              </div>
              <div class="setting-control">
                <input type="number" class="input input-mono" id="maxTokensInput" style="min-width: 100px; width: 100px;" min="16" max="512" step="16">
              </div>
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Max Context Tokens</span>
                <span class="setting-desc">How much surrounding code to send to the model (higher = smarter but slower)</span>
              </div>
              <div class="setting-control">
                <input type="number" class="input input-mono" id="maxContextInput" style="min-width: 100px; width: 100px;" min="512" max="32768" step="512">
              </div>
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Max Completion Lines</span>
                <span class="setting-desc">Limit the number of lines in a single suggestion</span>
              </div>
              <div class="setting-control">
                <input type="number" class="input input-mono" id="maxLinesInput" style="min-width: 100px; width: 100px;" min="1" max="200" step="5">
              </div>
            </div>
          </div>
          <div class="section">
            <div class="section-title">Prefetching &amp; Caching</div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Speculative Prefetch</span>
                <span class="setting-desc">Pre-compute completions for predicted next cursor positions</span>
              </div>
              <div class="setting-control">
                <label class="toggle">
                  <input type="checkbox" id="togglePrefetch" data-key="prefetchEnabled">
                  <span class="toggle-track"><span class="toggle-thumb"></span></span>
                </label>
              </div>
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Completion Cache</span>
                <span class="setting-desc">Cache recent completions for instant replay on revisited lines</span>
              </div>
              <div class="setting-control">
                <label class="toggle">
                  <input type="checkbox" id="toggleCache" data-key="cacheEnabled">
                  <span class="toggle-track"><span class="toggle-thumb"></span></span>
                </label>
              </div>
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Cache TTL</span>
                <span class="setting-desc">Seconds before cached completions expire</span>
              </div>
              <div class="setting-control">
                <input type="number" class="input input-mono" id="cacheTTLInput" style="min-width: 100px; width: 100px;" min="30" max="3600" step="30">
              </div>
            </div>
          </div>
        </div>

        <!-- Advanced Page -->
        <div class="page" id="page-advanced">
          <div class="section">
            <div class="section-title">Intelligence</div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Style Learning</span>
                <span class="setting-desc">Automatically learn your project's naming conventions, indentation, and patterns</span>
              </div>
              <div class="setting-control">
                <label class="toggle">
                  <input type="checkbox" id="toggleStyleLearn" data-key="styleLearnEnabled">
                  <span class="toggle-track"><span class="toggle-thumb"></span></span>
                </label>
              </div>
            </div>
          </div>
          <div class="section">
            <div class="section-title">Diagnostics</div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Log Level</span>
                <span class="setting-desc">Control how much internal detail is logged to the output channel</span>
              </div>
              <div class="setting-control">
                <select class="input" id="logLevelSelect" style="min-width: 140px;">
                  <option value="debug">Debug</option>
                  <option value="info">Info</option>
                  <option value="warn">Warning</option>
                  <option value="error">Error</option>
                </select>
              </div>
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Output Log</span>
                <span class="setting-desc">Open the AutoCode output channel to inspect engine internals</span>
              </div>
              <div class="setting-control">
                <button class="btn btn-secondary" id="openLogBtn">Open Log</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  </div>

  <div class="toast-container" id="toastContainer"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let config = {};
    let availableModels = [];

    // Init
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
        renderModelPills();
      }
      if (m.type === 'saveResult') {
        toast(m.success ? 'success' : 'error', m.message);
      }
      if (m.type === 'connectionTest') {
        toast(m.status === 'success' ? 'success' : m.status === 'error' ? 'error' : 'info', m.message);
      }
    });

    // Navigation
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        const pageId = item.dataset.page;
        document.getElementById('page-' + pageId).classList.add('active');
        const titles = { general: 'General', models: 'Models', performance: 'Performance', advanced: 'Advanced' };
        const descs = { general: 'Configure provider and core services', models: 'Select and configure your AI model', performance: 'Fine-tune speed and resource usage', advanced: 'Intelligence and diagnostics' };
        document.getElementById('pageTitle').textContent = titles[pageId];
        document.getElementById('pageDesc').textContent = descs[pageId];
      });
    });

    // Provider Change
    document.querySelectorAll('.pill').forEach(pill => {
      pill.addEventListener('click', () => {
        const provider = pill.dataset.provider;
        vscode.postMessage({ type: 'saveConfig', key: 'provider', value: provider });
        if (provider === 'ollama') {
           vscode.postMessage({ type: 'fetchModels' });
        }
      });
    });

    // Save API Key
    document.getElementById('saveKeyBtn').addEventListener('click', () => {
      const key = document.getElementById('apiKeyInput').value;
      if (key) {
        vscode.postMessage({ type: 'saveApiKey', provider: config.provider, apiKey: key });
        document.getElementById('apiKeyInput').value = '';
      }
    });

    // Test Connection
    document.getElementById('testConnBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'testConnection' });
    });

    // Refresh Models
    document.getElementById('refreshModelsBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'fetchModels' });
    });

    // Open Log
    document.getElementById('openLogBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'openOutputLog' });
    });

    // Toggles (auto-save on change)
    document.querySelectorAll('.toggle input').forEach(input => {
      input.addEventListener('change', () => {
        vscode.postMessage({ type: 'saveConfig', key: input.dataset.key, value: input.checked });
      });
    });

    // Log Level select
    document.getElementById('logLevelSelect').addEventListener('change', (e) => {
      vscode.postMessage({ type: 'saveConfig', key: 'logLevel', value: e.target.value });
    });

    // Number/Text inputs (auto-save on blur)
    const inputMap = {
      modelInput: { key: 'model', type: 'string' },
      endpointInput: { key: 'apiEndpoint', type: 'string' },
      debounceInput: { key: 'debounceMs', type: 'number' },
      maxTokensInput: { key: 'maxTokens', type: 'number' },
      maxContextInput: { key: 'maxContextTokens', type: 'number' },
      maxLinesInput: { key: 'maxCompletionLines', type: 'number' },
      cacheTTLInput: { key: 'cacheTTLSeconds', type: 'number' }
    };
    Object.entries(inputMap).forEach(([id, spec]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('blur', () => {
        const val = spec.type === 'number' ? parseInt(el.value) : el.value;
        if (spec.type === 'number' && isNaN(val)) return;
        vscode.postMessage({ type: 'saveConfig', key: spec.key, value: val });
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') el.blur();
      });
    });

    function render() {
      // Provider Pills
      document.querySelectorAll('.pill').forEach(p => {
        p.classList.toggle('active', p.dataset.provider === config.provider);
      });

      // API Key Row (hidden for Ollama)
      document.getElementById('apiKeyRow').classList.toggle('hidden', config.provider === 'ollama');

      // Toggles
      document.getElementById('toggleEnabled').checked = !!config.enabled;
      document.getElementById('toggleStreaming').checked = !!config.streamingEnabled;
      document.getElementById('togglePrefetch').checked = !!config.prefetchEnabled;
      document.getElementById('toggleCache').checked = !!config.cacheEnabled;
      document.getElementById('toggleStyleLearn').checked = !!config.styleLearnEnabled;

      // Text/Number Inputs
      document.getElementById('modelInput').value = config.model || '';
      document.getElementById('endpointInput').value = config.apiEndpoint || '';
      document.getElementById('debounceInput').value = config.debounceMs || 150;
      document.getElementById('maxTokensInput').value = config.maxTokens || 64;
      document.getElementById('maxContextInput').value = config.maxContextTokens || 8192;
      document.getElementById('maxLinesInput').value = config.maxCompletionLines || 50;
      document.getElementById('cacheTTLInput').value = config.cacheTTLSeconds || 300;

      // Log Level
      document.getElementById('logLevelSelect').value = config.logLevel || 'info';

      // Ollama Container
      document.getElementById('ollamaModelContainer').classList.toggle('hidden', config.provider !== 'ollama');
      if (config.provider === 'ollama') renderModelPills();
    }

    function renderModelPills() {
      const list = document.getElementById('modelPillList');
      list.innerHTML = '';
      availableModels.forEach(m => {
        const pill = document.createElement('div');
        pill.className = 'model-pill' + (config.model === m ? ' active' : '');
        pill.textContent = m;
        pill.addEventListener('click', () => {
          vscode.postMessage({ type: 'saveConfig', key: 'model', value: m });
        });
        list.appendChild(pill);
      });
      if (availableModels.length === 0) {
        list.innerHTML = '<span style="font-size:11px; color:var(--text-muted);">No models detected. Is Ollama running?</span>';
      }
    }

    function toast(type, message) {
      const container = document.getElementById('toastContainer');
      const el = document.createElement('div');
      el.className = 'toast ' + type;
      el.textContent = message;
      container.appendChild(el);
      setTimeout(() => {
        el.style.opacity = '0';
        el.style.transition = 'opacity 0.4s';
        setTimeout(() => el.remove(), 400);
      }, 3000);
    }
  </script>
</body>
</html>`;
  }

  dispose(): void {
    SettingsPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
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
