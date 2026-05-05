/**
 * AutoCode Settings Panel
 *
 * Multi-page settings interface with sidebar navigation.
 * Design: Brutalist-refined — geometric forms, high contrast, intentional hierarchy.
 */

import * as vscode from 'vscode';
import { ConfigManager } from '../core/config';
import { Logger } from '../core/logger';

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
  private readonly logger: Logger;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    _extensionUri: vscode.Uri
  ) {
    this.panel = panel;
    this.config = ConfigManager.getInstance();
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

  public static createOrShow(extensionUri: vscode.Uri): void {
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

    SettingsPanel.currentPanel = new SettingsPanel(panel, extensionUri);
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

      case 'openOutputLog':
        Logger.getInstance().show();
        break;
    }
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
    return {
      enabled: config.enabled,
      provider: config.provider,
      model: config.model,
      apiKeySet: !!apiKey,
      apiKeyPreview: apiKey
        ? apiKey.substring(0, 6) + '••••' + apiKey.substring(apiKey.length - 4)
        : '',
      apiEndpoint: config.apiEndpoint,
      maxContextTokens: config.maxContextTokens,
      debounceMs: config.debounceMs,
      prefetchEnabled: config.prefetchEnabled,
      maxCompletionLines: config.maxCompletionLines,
      streamingEnabled: config.streamingEnabled,
      cacheEnabled: config.cacheEnabled,
      cacheTTLSeconds: config.cacheTTLSeconds,
      styleLearnEnabled: config.styleLearnEnabled,
      logLevel: config.logLevel,
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
      --accent: var(--vscode-button-background, #0e639c);
      --accent-hover: var(--vscode-button-hoverBackground, #1177bb);
      --bg: var(--vscode-editor-background);
      --bg-subtle: var(--vscode-sideBar-background, var(--bg));
      --border: var(--vscode-widget-border, rgba(128,128,128,0.15));
      --text: var(--vscode-editor-foreground);
      --text-muted: var(--vscode-descriptionForeground);
      --text-subtle: var(--vscode-disabledForeground);
      --success: var(--vscode-testing-iconPassed, #73c991);
      --error: var(--vscode-errorForeground, #f44747);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
      font-size: 13px;
      color: var(--text);
      background: var(--bg);
      line-height: 1.5;
      overflow: hidden;
    }

    .app {
      display: flex;
      height: 100vh;
    }

    /* Sidebar - minimal, no icons */
    .sidebar {
      width: 180px;
      background: var(--bg-subtle);
      border-right: 1px solid var(--border);
      padding: 20px 0;
      display: flex;
      flex-direction: column;
    }

    .nav-header {
      padding: 0 16px 16px;
      margin-bottom: 8px;
    }

    .nav-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: var(--text-muted);
    }

    .nav-item {
      padding: 6px 16px;
      cursor: pointer;
      font-size: 13px;
      color: var(--text-muted);
      transition: color 0.15s ease;
      border-left: 2px solid transparent;
    }

    .nav-item:hover {
      color: var(--text);
    }

    .nav-item.active {
      color: var(--text);
      border-left-color: var(--accent);
      background: linear-gradient(90deg, rgba(14,99,156,0.08) 0%, transparent 100%);
    }

    /* Main Content */
    .main {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--bg);
    }

    .header {
      padding: 24px 32px 16px;
    }

    .header h1 {
      font-size: 22px;
      font-weight: 500;
      letter-spacing: -0.3px;
    }

    .header p {
      font-size: 13px;
      color: var(--text-muted);
      margin-top: 2px;
    }

    .content {
      flex: 1;
      overflow-y: auto;
      padding: 0 32px 40px;
    }

    .page {
      display: none;
      max-width: 720px;
    }

    .page.active {
      display: block;
      animation: fadeIn 0.2s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    /* Section Headers - like Cursor */
    .section {
      margin-bottom: 32px;
    }

    .section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: var(--text-muted);
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }

    /* Setting Rows - clean horizontal layout */
    .setting-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 0;
      border-bottom: 1px solid var(--border);
    }

    .setting-row:last-child {
      border-bottom: none;
    }

    .setting-info {
      flex: 1;
      min-width: 0;
    }

    .setting-label {
      font-size: 13px;
      font-weight: 400;
      color: var(--text);
      display: block;
    }

    .setting-desc {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 1px;
      display: block;
    }

    .setting-control {
      flex-shrink: 0;
      margin-left: 24px;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    /* Toggle Switch - Cursor style */
    .toggle {
      position: relative;
      width: 36px;
      height: 20px;
    }

    .toggle input {
      opacity: 0;
      width: 0;
      height: 0;
    }

    .toggle-track {
      position: absolute;
      inset: 0;
      background: var(--text-subtle);
      border-radius: 20px;
      transition: background 0.2s ease;
      cursor: pointer;
    }

    .toggle-thumb {
      position: absolute;
      width: 14px;
      height: 14px;
      left: 3px;
      top: 3px;
      background: white;
      border-radius: 50%;
      transition: transform 0.2s ease;
    }

    .toggle input:checked + .toggle-track {
      background: var(--accent);
    }

    .toggle input:checked + .toggle-track .toggle-thumb {
      transform: translateX(16px);
    }

    /* Provider Pills - horizontal row */
    .provider-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .provider-pill {
      padding: 6px 14px;
      border-radius: 4px;
      font-size: 13px;
      cursor: pointer;
      transition: all 0.15s ease;
      border: 1px solid transparent;
      color: var(--text-muted);
    }

    .provider-pill:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.1));
      color: var(--text);
    }

    .provider-pill.active {
      background: var(--accent);
      color: white;
      border-color: var(--accent);
    }

    /* Inputs - minimal */
    .input {
      background: var(--vscode-input-background, rgba(128,128,128,0.08));
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 13px;
      color: var(--text);
      font-family: inherit;
      outline: none;
      transition: border-color 0.15s ease;
      min-width: 200px;
    }

    .input:focus {
      border-color: var(--accent);
    }

    .input::placeholder {
      color: var(--text-subtle);
    }

    .input-small {
      min-width: 100px;
      width: 100px;
    }

    .input-mono {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }

    /* Select - minimal */
    .select {
      background: var(--vscode-input-background, rgba(128,128,128,0.08));
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 6px 24px 6px 10px;
      font-size: 13px;
      color: var(--text);
      font-family: inherit;
      outline: none;
      cursor: pointer;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 8px center;
    }

    .select:focus {
      border-color: var(--accent);
    }

    /* API Key row with inline button */
    .apikey-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .apikey-input {
      flex: 1;
      min-width: 280px;
    }

    /* Buttons - minimal */
    .btn {
      padding: 6px 12px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      border: none;
      font-family: inherit;
    }

    .btn-primary {
      background: var(--accent);
      color: white;
    }

    .btn-primary:hover {
      background: var(--accent-hover);
    }

    .btn-secondary {
      background: transparent;
      color: var(--text-muted);
      border: 1px solid var(--border);
    }

    .btn-secondary:hover {
      color: var(--text);
      border-color: var(--text-muted);
    }

    .btn-small {
      padding: 4px 10px;
      font-size: 11px;
    }

    /* Compact number input with suffix */
    .number-field {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .number-suffix {
      font-size: 12px;
      color: var(--text-muted);
    }

    /* Status badge */
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 500;
      color: var(--text-muted);
      margin-left: 12px;
    }

    .status-badge::before {
      content: '';
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--error);
    }

    .status-badge.ready::before {
      background: var(--success);
    }

    /* Shortcuts - simple grid */
    .shortcuts-list {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 8px 24px;
      font-size: 12px;
    }

    .shortcuts-list kbd {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      color: var(--text-muted);
      background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.1));
      padding: 2px 6px;
      border-radius: 3px;
    }

    .shortcuts-list span {
      color: var(--text-muted);
    }

    /* Toast notifications */
    .toast-container {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 100;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .toast {
      padding: 10px 16px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
      animation: slideIn 0.2s ease;
      background: var(--vscode-notifications-background, var(--bg-subtle));
      color: var(--text);
      border: 1px solid var(--border);
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    }

    @keyframes slideIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .toast.success {
      border-color: var(--success);
      color: var(--success);
    }

    .toast.error {
      border-color: var(--error);
      color: var(--error);
    }

    /* Responsive */
    @media (max-width: 600px) {
      .sidebar { display: none; }
      .content { padding: 0 16px 24px; }
    }
  </style>
</head>
<body>
  <div class="app">
    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="nav-header">
        <div class="nav-title">Settings</div>
      </div>
      <nav>
        <div class="nav-item active" data-page="general">General</div>
        <div class="nav-item" data-page="models">Models</div>
        <div class="nav-item" data-page="performance">Performance</div>
        <div class="nav-item" data-page="advanced">Advanced</div>
      </nav>
    </aside>

    <!-- Main Content -->
    <main class="main">
      <header class="header">
        <h1 id="pageTitle">General</h1>
        <p id="pageDesc">Configure provider and basic settings</p>
      </header>

      <div class="content">
        <!-- General Page -->
        <div class="page active" id="page-general">
          <div class="section">
            <div class="section-title">Provider</div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">AI Provider</span>
                <span class="setting-desc">Select the service for code completion</span>
              </div>
              <div class="setting-control">
                <div class="provider-row">
                  <div class="provider-pill active" data-provider="openai">OpenAI</div>
                  <div class="provider-pill" data-provider="anthropic">Anthropic</div>
                  <div class="provider-pill" data-provider="ollama">Ollama</div>
                  <div class="provider-pill" data-provider="custom">Custom</div>
                </div>
              </div>
            </div>

            <div class="setting-row" id="apiKeyRow">
              <div class="setting-info">
                <span class="setting-label">API Key</span>
                <span class="setting-desc" id="apiKeyDesc">Stored securely in VS Code SecretStorage</span>
              </div>
              <div class="setting-control">
                <div class="apikey-wrap">
                  <input type="password" class="input input-mono apikey-input" id="apiKeyInput" placeholder="sk-..." autocomplete="off">
                  <button class="btn btn-primary btn-small" id="saveKeyBtn">Save</button>
                </div>
                <span class="status-badge" id="keyStatus">No key</span>
              </div>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Features</div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Enable AutoCode</span>
                <span class="setting-desc">Master switch for inline completions</span>
              </div>
              <div class="setting-control">
                <label class="toggle">
                  <input type="checkbox" id="toggleEnabled" data-key="enabled">
                  <span class="toggle-track"><span class="toggle-thumb"></span></span>
                </label>
              </div>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Style Learning</span>
                <span class="setting-desc">Adapt completions to your coding patterns</span>
              </div>
              <div class="setting-control">
                <label class="toggle">
                  <input type="checkbox" id="toggleStyle" data-key="styleLearnEnabled">
                  <span class="toggle-track"><span class="toggle-thumb"></span></span>
                </label>
              </div>
            </div>
          </div>
        </div>

        <!-- Models Page -->
        <div class="page" id="page-models">
          <div class="section">
            <div class="section-title">Model Configuration</div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Model ID</span>
                <span class="setting-desc">Specific model for completions</span>
              </div>
              <div class="setting-control">
                <input type="text" class="input input-mono" id="modelInput" placeholder="gpt-4o">
              </div>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">API Endpoint</span>
                <span class="setting-desc">Override the default endpoint URL</span>
              </div>
              <div class="setting-control">
                <input type="text" class="input input-mono" id="endpointInput" placeholder="https://api.openai.com/v1">
              </div>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Enable Streaming</span>
                <span class="setting-desc">Receive completions incrementally</span>
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
            <div class="section-title">Timing</div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Debounce</span>
                <span class="setting-desc">Delay before triggering completion</span>
              </div>
              <div class="setting-control">
                <div class="number-field">
                  <input type="number" class="input input-small" id="debounceInput" min="50" max="500" step="10">
                  <span class="number-suffix">ms</span>
                </div>
              </div>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Max Lines</span>
                <span class="setting-desc">Maximum completion length</span>
              </div>
              <div class="setting-control">
                <div class="number-field">
                  <input type="number" class="input input-small" id="maxLinesInput" min="5" max="200" step="5">
                  <span class="number-suffix">lines</span>
                </div>
              </div>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Context</div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Max Context Tokens</span>
                <span class="setting-desc">Tokens sent to the model</span>
              </div>
              <div class="setting-control">
                <div class="number-field">
                  <input type="number" class="input input-small" id="contextTokensInput" min="1024" max="32768" step="1024">
                  <span class="number-suffix">tokens</span>
                </div>
              </div>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Speculative Prefetch</span>
                <span class="setting-desc">Pre-generate completions for faster response</span>
              </div>
              <div class="setting-control">
                <label class="toggle">
                  <input type="checkbox" id="togglePrefetch" data-key="prefetchEnabled">
                  <span class="toggle-track"><span class="toggle-thumb"></span></span>
                </label>
              </div>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Caching</div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Enable Cache</span>
                <span class="setting-desc">Store and reuse recent completions</span>
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
                <span class="setting-desc">How long to keep cached results</span>
              </div>
              <div class="setting-control">
                <div class="number-field">
                  <input type="number" class="input input-small" id="cacheTtlInput" min="30" max="3600" step="30">
                  <span class="number-suffix">sec</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Advanced Page -->
        <div class="page" id="page-advanced">
          <div class="section">
            <div class="section-title">Logging</div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Log Level</span>
                <span class="setting-desc">Verbosity of output panel</span>
              </div>
              <div class="setting-control">
                <select class="select" id="logLevelSelect">
                  <option value="debug">Debug</option>
                  <option value="info">Info</option>
                  <option value="warn">Warning</option>
                  <option value="error">Error</option>
                </select>
              </div>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Output Panel</span>
                <span class="setting-desc">View extension logs</span>
              </div>
              <div class="setting-control">
                <button class="btn btn-secondary btn-small" id="openLogBtn">Open</button>
              </div>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Keyboard Shortcuts</div>
            <div class="shortcuts-list">
              <kbd>Tab</kbd><span>Accept suggestion</span>
              <kbd>Cmd+→</kbd><span>Accept word</span>
              <kbd>Cmd+Shift+→</kbd><span>Accept line</span>
              <kbd>Esc</kbd><span>Dismiss completion</span>
              <kbd>Ctrl+Space</kbd><span>Force trigger</span>
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
    let currentPage = 'general';

    const pageInfo = {
      general: { title: 'General', desc: 'Configure provider and basic settings' },
      models: { title: 'Models', desc: 'Select and configure your AI model' },
      performance: { title: 'Performance', desc: 'Fine-tune speed and resource usage' },
      advanced: { title: 'Advanced', desc: 'Logging and keyboard shortcuts' },
    };

    // Init
    vscode.postMessage({ type: 'getConfig' });

    // Message handling
    window.addEventListener('message', (e) => {
      const m = e.data;
      if (m.type === 'configUpdate') {
        config = m.config;
        render(config);
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
        const page = item.dataset.page;
        if (page === currentPage) return;

        document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');

        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.getElementById('page-' + page).classList.add('active');

        const info = pageInfo[page];
        document.getElementById('pageTitle').textContent = info.title;
        document.getElementById('pageDesc').textContent = info.desc;

        currentPage = page;
      });
    });

    // Provider selection
    document.querySelectorAll('.provider-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('.provider-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        config.provider = pill.dataset.provider;

        // Show/hide API key row
        const apiKeyRow = document.getElementById('apiKeyRow');
        apiKeyRow.style.display = pill.dataset.provider === 'ollama' ? 'none' : 'flex';

        // Set default endpoint for Ollama
        if (pill.dataset.provider === 'ollama' && !document.getElementById('endpointInput').value) {
          document.getElementById('endpointInput').value = 'http://localhost:11434';
        }

        // Set default model
        const defaults = { openai: 'gpt-4o', anthropic: 'claude-sonnet-4-20250514', ollama: 'llama3.1', custom: 'gpt-4o' };
        const modelInput = document.getElementById('modelInput');
        if (!modelInput.value || Object.values(defaults).includes(modelInput.value)) {
          modelInput.value = defaults[pill.dataset.provider] || '';
        }

        // Auto-save provider
        vscode.postMessage({ type: 'saveConfig', key: 'provider', value: pill.dataset.provider });
      });
    });

    // Save API Key
    document.getElementById('saveKeyBtn').addEventListener('click', () => {
      const provider = document.querySelector('.provider-pill.active')?.dataset.provider || 'openai';
      const key = document.getElementById('apiKeyInput').value;

      if (!key && provider !== 'ollama' && !config.apiKeySet) {
        toast('error', 'Please enter an API key');
        return;
      }

      if (key) {
        vscode.postMessage({ type: 'saveApiKey', provider, apiKey: key });
        document.getElementById('apiKeyInput').value = '';
        toast('success', 'API key saved');
      }
    });

    // Toggles - auto-save
    document.querySelectorAll('.toggle input').forEach(toggle => {
      toggle.addEventListener('change', () => {
        vscode.postMessage({ type: 'saveConfig', key: toggle.dataset.key, value: toggle.checked });
      });
    });

    // Number inputs - auto-save on blur
    const numberInputs = ['debounceInput', 'maxLinesInput', 'contextTokensInput', 'cacheTtlInput'];
    const numberKeys = ['debounceMs', 'maxCompletionLines', 'maxContextTokens', 'cacheTTLSeconds'];
    numberInputs.forEach((id, i) => {
      document.getElementById(id).addEventListener('blur', (e) => {
        const val = parseInt(e.target.value);
        if (!isNaN(val)) {
          vscode.postMessage({ type: 'saveConfig', key: numberKeys[i], value: val });
        }
      });
    });

    // Text inputs - auto-save on blur
    ['modelInput', 'endpointInput'].forEach(id => {
      const key = id === 'modelInput' ? 'model' : 'apiEndpoint';
      document.getElementById(id).addEventListener('blur', (e) => {
        if (e.target.value) {
          vscode.postMessage({ type: 'saveConfig', key, value: e.target.value });
        }
      });
    });

    // Log level
    document.getElementById('logLevelSelect').addEventListener('change', (e) => {
      vscode.postMessage({ type: 'saveConfig', key: 'logLevel', value: e.target.value });
    });

    // Open Log
    document.getElementById('openLogBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'openOutputLog' });
    });

    // Render
    function render(c) {
      // Provider
      document.querySelectorAll('.provider-pill').forEach(pill => {
        pill.classList.toggle('active', pill.dataset.provider === c.provider);
      });

      // API key row visibility
      document.getElementById('apiKeyRow').style.display = c.provider === 'ollama' ? 'none' : 'flex';

      // Key status
      const keyStatus = document.getElementById('keyStatus');
      if (c.apiKeySet) {
        keyStatus.textContent = 'Key set';
        keyStatus.className = 'status-badge ready';
        document.getElementById('apiKeyDesc').textContent = c.apiKeyPreview ? 'Current: ' + c.apiKeyPreview : 'Key stored securely';
      } else {
        keyStatus.textContent = 'No key';
        keyStatus.className = 'status-badge';
        document.getElementById('apiKeyDesc').textContent = 'Stored securely in VS Code SecretStorage';
      }

      // Model & endpoint
      document.getElementById('modelInput').value = c.model || '';
      document.getElementById('endpointInput').value = c.apiEndpoint || '';

      // Toggles
      document.getElementById('toggleEnabled').checked = c.enabled;
      document.getElementById('toggleStyle').checked = c.styleLearnEnabled;
      document.getElementById('toggleStreaming').checked = c.streamingEnabled;
      document.getElementById('togglePrefetch').checked = c.prefetchEnabled;
      document.getElementById('toggleCache').checked = c.cacheEnabled;

      // Numbers
      document.getElementById('debounceInput').value = c.debounceMs;
      document.getElementById('contextTokensInput').value = c.maxContextTokens;
      document.getElementById('maxLinesInput').value = c.maxCompletionLines;
      document.getElementById('cacheTtlInput').value = c.cacheTTLSeconds;

      // Log level
      document.getElementById('logLevelSelect').value = c.logLevel;
    }

    // Toast
    function toast(type, message) {
      const container = document.getElementById('toastContainer');
      const el = document.createElement('div');
      el.className = 'toast ' + type;
      el.textContent = message;
      container.appendChild(el);

      setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(10px)';
        setTimeout(() => el.remove(), 200);
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
