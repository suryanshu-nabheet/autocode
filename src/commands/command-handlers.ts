/**
 * AutoCode Command Handlers
 * 
 * Registers and handles all VS Code commands for the AutoCode engine.
 */

import * as vscode from 'vscode';
import { Logger } from '../core/logger';
import { EventBus } from '../core/event-bus';
import { ConfigManager } from '../core/config';
import { ContextEngine } from '../context/context-engine';
import { PredictionEngine } from '../prediction/prediction-engine';
import { AutoCodeCompletionProvider } from '../providers/completion-provider';
import { PerformanceMonitor } from '../performance/performance-monitor';
import { SettingsPanel } from '../settings/settings-panel';
import { ModelLayer } from '../models/model-layer';

/**
 * Manages the registration and execution of user-facing commands.
 */
export class CommandHandlers implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private logger: Logger;
  private eventBus: EventBus;
  private config: ConfigManager;
  private contextEngine: ContextEngine;
  private predictionEngine: PredictionEngine;
  private completionProvider: AutoCodeCompletionProvider;
  private perfMonitor: PerformanceMonitor;
  private modelLayer: ModelLayer;
  private extensionUri: vscode.Uri;

  constructor(
    contextEngine: ContextEngine,
    predictionEngine: PredictionEngine,
    completionProvider: AutoCodeCompletionProvider,
    perfMonitor: PerformanceMonitor,
    modelLayer: ModelLayer,
    extensionUri: vscode.Uri
  ) {
    this.logger = Logger.getInstance();
    this.eventBus = EventBus.getInstance();
    this.config = ConfigManager.getInstance();
    this.contextEngine = contextEngine;
    this.predictionEngine = predictionEngine;
    this.completionProvider = completionProvider;
    this.perfMonitor = perfMonitor;
    this.modelLayer = modelLayer;
    this.extensionUri = extensionUri;

    this.registerCommands();
  }

  /**
   * Registers all commands with VS Code.
   */
  private registerCommands(): void {
    this.register('autocode.acceptSuggestion', () => this.acceptSuggestion());
    this.register('autocode.acceptWord', () => this.acceptWord());
    this.register('autocode.acceptLine', () => this.acceptLine());
    this.register('autocode.dismissSuggestion', () => this.dismissSuggestion());
    this.register('autocode.triggerCompletion', () => this.triggerCompletion());
    this.register('autocode.toggleEnabled', () => this.toggleEnabled());
    this.register('autocode.clearCache', () => this.clearCache());
    this.register('autocode.reindexProject', () => this.reindexProject());
    this.register('autocode.openSettings', () => this.openSettings());
    this.register('autocode.onCompletionAccepted', (completion) => this.onCompletionAccepted(completion));
  }

  /**
   * Post-acceptance hook.
   */
  private async onCompletionAccepted(completion: any): Promise<void> {
    this.logger.debug(`Completion accepted: ${completion?.id ?? 'inline'}`);
    this.completionProvider.chainAfterAccept();
  }

  private register(
    commandId: string,
    handler: (...args: any[]) => any
  ): void {
    this.disposables.push(
      vscode.commands.registerCommand(commandId, handler)
    );
  }

  private async acceptSuggestion(): Promise<void> {
    const accepted = await this.completionProvider.acceptFull();
    if (!accepted) {
      await vscode.commands.executeCommand('tab');
    }
  }

  private async acceptWord(): Promise<void> {
    const accepted = await this.completionProvider.acceptWord();
    if (!accepted) {
      await vscode.commands.executeCommand('cursorWordRight');
    }
  }

  private async acceptLine(): Promise<void> {
    const accepted = await this.completionProvider.acceptLine();
    if (!accepted) {
      await vscode.commands.executeCommand('cursorEnd');
    }
  }

  private dismissSuggestion(): void {
    this.completionProvider.dismiss();
  }

  private async triggerCompletion(): Promise<void> {
    await vscode.commands.executeCommand(
      'editor.action.inlineSuggest.trigger'
    );
  }

  private async toggleEnabled(): Promise<void> {
    const current = this.config.getValue('enabled');
    await vscode.workspace
      .getConfiguration('autocode')
      .update('enabled', !current, true);

    this.logger.info(`Engine ${!current ? 'Enabled' : 'Disabled'}`);
  }

  private async clearCache(): Promise<void> {
    this.predictionEngine.clearCache();
    this.contextEngine.clearCache();
    this.completionProvider.clearState();
    this.perfMonitor.reset();
    this.logger.info('All caches cleared');
    vscode.window.showInformationMessage('AutoCode: All caches cleared');
  }

  private async reindexProject(): Promise<void> {
    this.logger.info('Re-indexing project...');
    await this.clearCache();
    this.logger.info('Re-index complete');
    vscode.window.showInformationMessage('AutoCode: Project re-indexed');
  }

  private openSettings(): void {
    SettingsPanel.createOrShow(this.extensionUri, this.modelLayer);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
