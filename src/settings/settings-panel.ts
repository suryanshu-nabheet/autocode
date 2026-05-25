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
import { getSettingsWebviewHtml } from './settings-ui';

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
      maxCompletionLines: config.maxCompletionLines ?? 24,
      streamingEnabled: config.streamingEnabled,
      cacheEnabled: config.cacheEnabled,
      cacheTTLSeconds: config.cacheTTLSeconds,
      styleLearnEnabled: config.styleLearnEnabled,
      logLevel: config.logLevel,
      maxTokens: config.maxTokens,
    };
  }

  private getWebviewContent(): string {
    return getSettingsWebviewHtml(getNonce());
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
