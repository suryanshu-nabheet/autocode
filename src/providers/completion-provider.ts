/**
 * AutoCode Inline Completion Provider
 * 
 * The VS Code integration point that provides inline completions.
 */

import * as vscode from 'vscode';
import { CompletionResult, ProjectContext } from '../core/types';
import { ConfigManager } from '../core/config';
import { Logger } from '../core/logger';
import { EventBus } from '../core/event-bus';
import { ContextEngine } from '../context/context-engine';
import { PredictionEngine } from '../prediction/prediction-engine';
import { PerformanceMonitor } from '../performance/performance-monitor';

/**
 * Provides inline completions for the AutoCode extension.
 */
export class AutoCodeCompletionProvider
  implements vscode.InlineCompletionItemProvider
{
  private config: ConfigManager;
  private logger: Logger;
  private eventBus: EventBus;
  private contextEngine: ContextEngine;
  private predictionEngine: PredictionEngine;
  private perfMonitor: PerformanceMonitor;

  /** Currently shown completion (for partial acceptance) */
  private currentCompletion: CompletionResult | null = null;
  /** Offset into the current completion text (for partial acceptance) */
  private acceptedOffset = 0;
  /** Last triggered position (to detect movement) */
  private lastPosition: vscode.Position | null = null;
  /** Prefetch completion for speculative next position */
  private prefetchResult: {
    key: string;
    result: CompletionResult;
  } | null = null;
  /** Track in-flight background requests to prevent stacking */
  private inFlightFetches = new Map<string, AbortController>();

  constructor(
    contextEngine: ContextEngine,
    predictionEngine: PredictionEngine,
    perfMonitor: PerformanceMonitor
  ) {
    this.config = ConfigManager.getInstance();
    this.logger = Logger.getInstance();
    this.eventBus = EventBus.getInstance();
    this.contextEngine = contextEngine;
    this.predictionEngine = predictionEngine;
    this.perfMonitor = perfMonitor;
  }

  /**
   * Main entry point called by VS Code when inline completions are needed
   */
  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | null> {
    const startTime = performance.now();
    
    if (!this.config.isReady() || this.isExcludedLanguage(document.languageId)) {
      return null;
    }

    const lineText = document.lineAt(position.line).text;
    const linePrefix = lineText.substring(0, position.character);

    // 1. FAST-PATH: Continuous Typing Fast-Forward (Sub-millisecond)
    if (this.lastPosition && this.currentCompletion) {
        if (position.line === this.lastPosition.line && position.character > this.lastPosition.character) {
            const typedText = lineText.substring(this.lastPosition.character, position.character);
            const remaining = this.currentCompletion.insertText.substring(this.acceptedOffset);
            
            if (remaining.startsWith(typedText)) {
                this.acceptedOffset += typedText.length;
                this.lastPosition = position;
                
                const newRemaining = remaining.substring(typedText.length);
                if (newRemaining.length > 0) {
                    this.logger.debug('Continuous typing: fast-forwarding completion');
                    return [this.createInlineItem(this.currentCompletion, position, document, newRemaining)];
                }
            }
            // If it doesn't match, we clear
            this.currentCompletion = null;
            this.acceptedOffset = 0;
        } else {
            this.currentCompletion = null;
            this.acceptedOffset = 0;
        }
    }

    this.lastPosition = position;

    // 2. ULTRA-FAST PATH: Predictive Cache (Sub-millisecond)
    const cacheKey = `${document.uri.toString()}:${position.line}:${linePrefix}`;
    const cached = await this.predictionEngine.getCachedCompletion(cacheKey);
    if (cached) {
        this.logger.debug('Sub-millisecond cache hit');
        this.currentCompletion = cached;
        this.acceptedOffset = 0;
        this.schedulePrefetch(document, position);
        return [this.createInlineItem(cached, position, document)];
    }

    // 3. BACKGROUND TASK: Speculative Fetch
    // We don't await this if we want sub-millisecond response for "null" results (to not block UI)
    // But if we want to show a result, we have to wait.
    // To satisfy the "not even a millisecond" requirement, we must have it prefetched.
    
    // Trigger background fetch for the CURRENT position if not cached
    this.triggerBackgroundFetch(document, position, token);

    // If we have a very fresh prefetch result from a previous trigger, use it
    if (this.prefetchResult && this.prefetchResult.key === cacheKey) {
        this.logger.debug('Using speculatively prefetched result');
        const res = this.prefetchResult.result;
        this.currentCompletion = res;
        this.acceptedOffset = 0;
        this.schedulePrefetch(document, position);
        return [this.createInlineItem(res, position, document)];
    }

    return null;
  }

  private async triggerBackgroundFetch(
      document: vscode.TextDocument,
      position: vscode.Position,
      token: vscode.CancellationToken
  ): Promise<void> {
      const linePrefix = document.lineAt(position.line).text.substring(0, position.character);
      const fetchKey = `${document.uri.toString()}:${position.line}:${linePrefix}`;

      // Check if there's already an in-flight request for this exact position
      if (this.inFlightFetches.has(fetchKey)) {
          this.logger.debug('Skipping duplicate background fetch', fetchKey);
          return;
      }

      // Create an abort controller to allow cancellation
      const controller = new AbortController();
      this.inFlightFetches.set(fetchKey, controller);

      try {
          const projectContext = await this.contextEngine.buildContext(document, position, token);

          // Check if cancelled during context build
          if (controller.signal.aborted || token.isCancellationRequested) {
              return;
          }

          const completion = await this.predictionEngine.getCompletion(document, position, projectContext, token);

          if (completion && !token.isCancellationRequested && !controller.signal.aborted) {
              this.prefetchResult = { key: fetchKey, result: completion };

              // If the user is still at the same position, we can try to re-trigger VS Code
              const currentPos = vscode.window.activeTextEditor?.selection.active;
              if (currentPos && currentPos.isEqual(position)) {
                  vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
              }
          }
      } catch (err) {
          this.logger.debug('Background fetch failed', err);
      } finally {
          this.inFlightFetches.delete(fetchKey);
      }
  }

  private createInlineItem(
    completion: CompletionResult,
    position: vscode.Position,
    document: vscode.TextDocument,
    overrideText?: string
  ): vscode.InlineCompletionItem {
    const text = overrideText !== undefined ? overrideText : completion.insertText;
    let range = new vscode.Range(position, position);

    if (completion.range && overrideText === undefined) {
       range = completion.range;
    }

    const item = new vscode.InlineCompletionItem(text, range);
    
    item.command = {
        title: 'Post-Acceptance Hook',
        command: 'autocode.onCompletionAccepted',
        arguments: [completion]
    };

    return item;
  }

  async acceptWord(): Promise<boolean> {
    if (!this.currentCompletion) {return false;}

    const remaining = this.currentCompletion.insertText.substring(
      this.acceptedOffset
    );
    if (!remaining) {return false;}

    const wordMatch = remaining.match(/^\s*\S+/);
    if (!wordMatch) {return false;}

    const wordText = wordMatch[0];
    this.acceptedOffset += wordText.length;

    const editor = vscode.window.activeTextEditor;
    if (editor) {
      await editor.edit((editBuilder) => {
        editBuilder.insert(editor.selection.active, wordText);
      });
    }

    this.eventBus.emit({
      type: 'completion_accepted',
      data: { id: this.currentCompletion.id, partial: true },
    });

    return true;
  }

  async acceptLine(): Promise<boolean> {
    if (!this.currentCompletion) {return false;}

    const remaining = this.currentCompletion.insertText.substring(
      this.acceptedOffset
    );
    if (!remaining) {return false;}

    const lineEnd = remaining.indexOf('\n');
    const lineText =
      lineEnd >= 0
        ? remaining.substring(0, lineEnd + 1)
        : remaining;

    this.acceptedOffset += lineText.length;

    const editor = vscode.window.activeTextEditor;
    if (editor) {
      await editor.edit((editBuilder) => {
        editBuilder.insert(editor.selection.active, lineText);
      });
    }

    this.eventBus.emit({
      type: 'completion_accepted',
      data: { id: this.currentCompletion.id, partial: true },
    });

    return true;
  }

  async acceptFull(): Promise<boolean> {
    if (!this.currentCompletion) {return false;}

    this.perfMonitor.recordAccepted();

    this.eventBus.emit({
      type: 'completion_accepted',
      data: { id: this.currentCompletion.id, partial: false },
    });

    this.currentCompletion = null;
    this.acceptedOffset = 0;

    return true;
  }

  dismiss(): void {
    if (this.currentCompletion) {
      this.perfMonitor.recordDismissed();

      this.eventBus.emit({
        type: 'completion_dismissed',
        data: {
          id: this.currentCompletion.id,
          reason: 'user_dismissed',
          text: this.currentCompletion.insertText,
          line: this.lastPosition?.line,
        },
      });
    }

    this.currentCompletion = null;
    this.acceptedOffset = 0;
  }

  private schedulePrefetch(
    document: vscode.TextDocument,
    currentPosition: vscode.Position
  ): void {
    if (!this.currentCompletion) {return;}

    const insertText = this.currentCompletion.insertText;
    const lines = insertText.split('\n');
    const endLine = currentPosition.line + lines.length - 1;
    const endChar =
      lines.length === 1
        ? currentPosition.character + insertText.length
        : lines[lines.length - 1].length;

    const nextPosition = new vscode.Position(endLine, endChar);

    setTimeout(async () => {
      try {
        const cts = new vscode.CancellationTokenSource();
        setTimeout(() => cts.cancel(), 5000);

        const context = await this.contextEngine.buildContext(
          document,
          nextPosition,
          cts.token
        );

        const result = await this.predictionEngine.getCompletion(
          document,
          nextPosition,
          context,
          cts.token
        );

        if (result) {
          const prefetchLineText = document.lineAt(nextPosition.line).text;
          const prefetchPrefix = prefetchLineText.substring(0, nextPosition.character);
          const key = `${document.uri.toString()}:${nextPosition.line}:${prefetchPrefix}`;
          this.prefetchResult = { key, result };
        }

        cts.dispose();
      } catch (err) {
        this.logger.debug('Prefetch failed', err);
      }
    }, 50);
  }

  clearState(): void {
    // Abort any in-flight requests
    for (const controller of this.inFlightFetches.values()) {
      controller.abort();
    }
    this.inFlightFetches.clear();

    this.currentCompletion = null;
    this.acceptedOffset = 0;
    this.lastPosition = null;
    this.prefetchResult = null;
    this.logger.info('Completion provider state cleared');
  }

  private isExcludedLanguage(langId: string): boolean {
    const excluded = [
      'log',
      'output',
      'binary',
      'search-result',
      'scm-input',
      'plaintext',
      'csv',
      'tsv',
      'markdown',
      'json',
      'jsonc',
      'yaml',
      'yml',
      'xml',
      'dockerfile',
    ];
    return excluded.includes(langId);
  }
}
