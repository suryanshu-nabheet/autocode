/**
 * AutoCode — Autonomous Code Engine
 * 
 * Extension Entry Point
 */

import * as vscode from 'vscode';
import { ConfigManager } from './core/config';
import { Logger } from './core/logger';
import { EventBus } from './core/event-bus';
import { ContextEngine } from './context/context-engine';
import { ModelLayer } from './models/model-layer';
import { PredictionEngine } from './prediction/prediction-engine';
import { AutoCodeCompletionProvider } from './providers/completion-provider';
import { CommandHandlers } from './commands/command-handlers';
import { PerformanceMonitor } from './performance/performance-monitor';
import { SettingsPanel } from './settings/settings-panel';

let disposables: vscode.Disposable[] = [];

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext): void {
  console.log('AutoCode: Activating...');
  
  const logger = Logger.getInstance();
  const config = ConfigManager.getInstance();
  ConfigManager.initialize(context.secrets);
  const eventBus = EventBus.getInstance();

  logger.setLevel(config.getValue('logLevel'));
  logger.info('AutoCode Engine activating...');

  disposables.push(
    config.onConfigChange((changed) => {
      if (changed.logLevel) {
        logger.setLevel(changed.logLevel);
      }
    })
  );

  const contextEngine = new ContextEngine();
  disposables.push(contextEngine);

  const modelLayer = new ModelLayer();
  disposables.push(modelLayer);

  const predictionEngine = new PredictionEngine(modelLayer);
  disposables.push(predictionEngine);

  const perfMonitor = new PerformanceMonitor();
  disposables.push(perfMonitor);

  const completionProvider = new AutoCodeCompletionProvider(
    contextEngine,
    predictionEngine,
    perfMonitor
  );

  const providerDisposable = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: '**' },
    completionProvider
  );
  disposables.push(providerDisposable);

  const commandHandlers = new CommandHandlers(
    contextEngine,
    predictionEngine,
    completionProvider,
    perfMonitor,
    context.extensionUri
  );
  disposables.push(commandHandlers);

  disposables.push(vscode.commands.registerCommand('autocode.checkStatus', async () => {
    const status = await modelLayer.checkStatus();
    if (status.ok) {
        vscode.window.showInformationMessage(`Status: OK. Provider: ${status.provider}, Model: ${status.model}`);
    } else {
        vscode.window.showErrorMessage(`Status: ERROR. ${status.error}`);
    }
  }));

  setupDocumentListeners(contextEngine, predictionEngine);

  disposables.push(logger, config, eventBus);
  context.subscriptions.push(...disposables);

  const readyMsg = config.isReady()
    ? `AutoCode Engine activated. Provider: ${config.getValue('provider')}, Model: ${config.getValue('model')}`
    : 'AutoCode Engine activated. Configure API key in settings to enable completions.';

  logger.info(readyMsg);

  if (!config.isReady()) {
    const openSettings = 'Open Settings';
    vscode.window.showInformationMessage(
      'Configure your API key to enable autonomous completions.',
      openSettings
    ).then((selected) => {
      if (selected === openSettings) {
        SettingsPanel.createOrShow(context.extensionUri);
      }
    });
  }
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
  const logger = Logger.getInstance();
  logger.info('AutoCode Engine deactivating...');

  for (const d of disposables) {
    try {
      d.dispose();
    } catch {
      // Best effort cleanup
    }
  }
  disposables = [];
}

/**
 * Set up listeners for document events
 */
function setupDocumentListeners(
  contextEngine: ContextEngine,
  _predictionEngine: PredictionEngine
): void {
  const logger = Logger.getInstance();

  disposables.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      logger.debug(`File saved: ${document.fileName}`);
    })
  );

  disposables.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (editor) {
        const cts = new vscode.CancellationTokenSource();
        setTimeout(() => cts.cancel(), 5000);
        try {
            await contextEngine.buildContext(editor.document, editor.selection.active, cts.token);
        } catch (err) {
            logger.debug('Background context update failed', err);
        } finally {
            cts.dispose();
        }
      }
    })
  );

  let selectionTimer: ReturnType<typeof setTimeout> | null = null;
  disposables.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (selectionTimer) {
        clearTimeout(selectionTimer);
      }

      const config = ConfigManager.getInstance();
      if (!config.getValue('enabled')) {return;}

      const debounceMs = config.getValue('debounceMs');
      selectionTimer = setTimeout(() => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === event.textEditor.document && editor.selection.isEmpty) {
          vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
        }
      }, debounceMs);
    })
  );
}
