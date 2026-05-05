/**
 * AutoCode Configuration Manager
 * 
 * Centralized configuration management with real-time change detection
 * and validation. All modules read configuration through this singleton.
 */

import * as vscode from 'vscode';
import { AutoCodeConfig, ModelProvider, LogLevel } from './types';

const CONFIG_SECTION = 'autocode';

const DEFAULT_CONFIG: AutoCodeConfig = {
  enabled: true,
  provider: 'ollama',
  model: 'qwen2.5-coder:1.5b',
  apiKey: '',
  apiEndpoint: 'http://localhost:11434',
  maxContextTokens: 8192,
  debounceMs: 150,
  prefetchEnabled: true,
  maxCompletionLines: 50,
  streamingEnabled: true,
  cacheEnabled: true,
  cacheTTLSeconds: 300,
  styleLearnEnabled: true,
  telemetryEnabled: false,
  logLevel: 'info',
};

export class ConfigManager implements vscode.Disposable {
  private static instance: ConfigManager;
  private config: AutoCodeConfig;
  private disposables: vscode.Disposable[] = [];
  private changeEmitter = new vscode.EventEmitter<Partial<AutoCodeConfig>>();
  private secretStorage: vscode.SecretStorage | null = null;
  private cachedSecretKey: string | null = null;

  /** Fired when any configuration value changes */
  public readonly onConfigChange = this.changeEmitter.event;

  private constructor() {
    this.config = this.loadConfig();

    // Watch for configuration changes in real-time
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(CONFIG_SECTION)) {
          const oldConfig = { ...this.config };
          this.config = this.loadConfig();
          const changed = this.diffConfig(oldConfig, this.config);
          if (Object.keys(changed).length > 0) {
            this.changeEmitter.fire(changed);
          }
        }
      })
    );
  }

  static initialize(secretStorage: vscode.SecretStorage): void {
    const instance = ConfigManager.getInstance();
    instance.secretStorage = secretStorage;
    // Warm the secret cache in the background
    instance.refreshSecretKey();
  }

  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  /** Get the API key from secure storage (preferred) or plain settings (fallback) */
  async getApiKey(): Promise<string> {
    if (this.cachedSecretKey !== null) {
      return this.cachedSecretKey;
    }
    if (this.secretStorage) {
      try {
        const secret = await this.secretStorage.get('autocode.apiKey');
        if (secret) {
          this.cachedSecretKey = secret;
          return secret;
        }
      } catch {
        // Fallback to plain settings below
      }
    }
    return this.config.apiKey || '';
  }

  /** Store the API key in secure storage and clear it from plain settings */
  async setApiKey(value: string): Promise<void> {
    this.cachedSecretKey = value;
    if (this.secretStorage) {
      if (value) {
        await this.secretStorage.store('autocode.apiKey', value);
      } else {
        await this.secretStorage.delete('autocode.apiKey');
      }
    }
    // Also clear from plain settings to migrate old users
    const wsConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const plain = wsConfig.get<string>('apiKey', '');
    if (plain) {
      await wsConfig.update('apiKey', undefined, true);
    }
  }

  private async refreshSecretKey(): Promise<void> {
    if (!this.secretStorage) {return;}
    try {
      this.cachedSecretKey = await this.secretStorage.get('autocode.apiKey') || null;
    } catch {
      this.cachedSecretKey = null;
    }
  }

  /** Get a snapshot of the current config */
  get(): AutoCodeConfig {
    return { ...this.config };
  }

  /** Get a single config value */
  getValue<K extends keyof AutoCodeConfig>(key: K): AutoCodeConfig[K] {
    return this.config[key];
  }

  /** Check if the engine is enabled and properly configured with enhanced validation */
  isReady(): boolean {
    if (!this.config.enabled) {return false;}

    const key = this.cachedSecretKey !== null ? this.cachedSecretKey : this.config.apiKey;

    // Provider-specific validation
    switch (this.config.provider) {
      case 'ollama':
        return true; // Ollama uses local endpoint, no key needed
      case 'openai':
        return !!key && key.trim().length > 0;
      case 'anthropic':
        return !!key && key.trim().length > 0;
      case 'custom':
        return !!this.config.apiEndpoint && this.config.apiEndpoint.trim().length > 0;
      default:
        return false;
    }
  }

  /** Get the effective API endpoint for the current provider */
  getEndpoint(): string {
    switch (this.config.provider) {
      case 'openai':
        return this.config.apiEndpoint || 'https://api.openai.com/v1';
      case 'anthropic':
        return this.config.apiEndpoint || 'https://api.anthropic.com/v1';
      case 'ollama':
        return this.config.apiEndpoint || 'http://localhost:11434';
      case 'custom':
        return this.config.apiEndpoint || '';
      default:
        return this.config.apiEndpoint || '';
    }
  }

  private loadConfig(): AutoCodeConfig {
    const wsConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return {
      enabled: wsConfig.get<boolean>('enabled', DEFAULT_CONFIG.enabled),
      provider: wsConfig.get<ModelProvider>('provider', DEFAULT_CONFIG.provider),
      model: wsConfig.get<string>('model', DEFAULT_CONFIG.model),
      apiKey: wsConfig.get<string>('apiKey', DEFAULT_CONFIG.apiKey),
      apiEndpoint: wsConfig.get<string>('apiEndpoint', DEFAULT_CONFIG.apiEndpoint),
      maxContextTokens: wsConfig.get<number>('maxContextTokens', DEFAULT_CONFIG.maxContextTokens),
      debounceMs: wsConfig.get<number>('debounceMs', DEFAULT_CONFIG.debounceMs),
      prefetchEnabled: wsConfig.get<boolean>('prefetchEnabled', DEFAULT_CONFIG.prefetchEnabled),
      maxCompletionLines: wsConfig.get<number>('maxCompletionLines', DEFAULT_CONFIG.maxCompletionLines),
      streamingEnabled: wsConfig.get<boolean>('streamingEnabled', DEFAULT_CONFIG.streamingEnabled),
      cacheEnabled: wsConfig.get<boolean>('cacheEnabled', DEFAULT_CONFIG.cacheEnabled),
      cacheTTLSeconds: wsConfig.get<number>('cacheTTLSeconds', DEFAULT_CONFIG.cacheTTLSeconds),
      styleLearnEnabled: wsConfig.get<boolean>('styleLearnEnabled', DEFAULT_CONFIG.styleLearnEnabled),
      telemetryEnabled: wsConfig.get<boolean>('telemetryEnabled', DEFAULT_CONFIG.telemetryEnabled),
      logLevel: wsConfig.get<LogLevel>('logLevel', DEFAULT_CONFIG.logLevel),
    };
  }

  private diffConfig(
    oldConfig: AutoCodeConfig,
    newConfig: AutoCodeConfig
  ): Partial<AutoCodeConfig> {
    const changed: Partial<AutoCodeConfig> = {};
    for (const key of Object.keys(newConfig) as (keyof AutoCodeConfig)[]) {
      if (oldConfig[key] !== newConfig[key]) {
        (changed as any)[key] = newConfig[key];
      }
    }
    return changed;
  }

  dispose(): void {
    this.changeEmitter.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
