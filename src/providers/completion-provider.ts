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
import { MultiFileCache } from '../cache/multi-file-cache';
import { ProactiveSuggester } from '../prediction/proactive-suggester';
import { SmartPrefetcher } from '../performance/smart-prefetcher';

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
  private multiFileCache: MultiFileCache;
  private proactiveSuggester: ProactiveSuggester;
  private smartPrefetcher: SmartPrefetcher;

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
    
    // Initialize advanced caching and proactive systems
    this.multiFileCache = new MultiFileCache(200, 500, 30000, 300000);
    this.smartPrefetcher = new SmartPrefetcher(
      this.multiFileCache,
      contextEngine,
      predictionEngine
    );
    this.proactiveSuggester = new ProactiveSuggester(
      this.multiFileCache,
      (pos) => this.triggerAtPosition(pos)
    );
  }
  
  /**
   * Trigger completion at specific position (for proactive suggester)
   */
  private triggerAtPosition(position: vscode.Position): void {
    vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
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

    // 2. ULTRA-FAST PATH: Multi-File L1 Cache (Sub-millisecond)
    const uri = document.uri.toString();
    const l1Result = this.multiFileCache.get(uri, position, linePrefix, document.languageId);
    
    if (l1Result) {
        this.logger.debug(`L${l1Result.level} cache hit in ${l1Result.metadata.latencyMs?.toFixed(2) ?? '<1'}ms`);
        this.eventBus.emit({
          type: 'cache_hit',
          data: { key: `${uri}:${position.line}`, level: l1Result.level, crossFile: l1Result.metadata.crossFile }
        });
        this.currentCompletion = l1Result.result;
        this.acceptedOffset = 0;
        
        // Schedule smart prefetch for next positions
        this.smartPrefetcher.schedulePrefetch(document, position, 'cache_hit');
        return [this.createInlineItem(l1Result.result, position, document)];
    }

    // 3. CROSS-FILE PATTERN MATCH: Check similar patterns in related files
    const relatedFiles = this.getRelatedFiles(document);
    if (relatedFiles.length > 0) {
        const crossFileResult = this.multiFileCache.findCrossFilePattern(
            linePrefix,
            document.languageId,
            relatedFiles.map(f => f.toString())
        );
        
        if (crossFileResult) {
            this.logger.debug('Cross-file pattern match found');
            this.eventBus.emit({
              type: 'cache_hit',
              data: { key: `${uri}:${position.line}`, level: 2, crossFile: true }
            });
            this.currentCompletion = crossFileResult;
            this.acceptedOffset = 0;
            return [this.createInlineItem(crossFileResult, position, document)];
        }
    }

    // 4. BACKGROUND TASK: Speculative Fetch with Smart Prefetcher
    this.triggerBackgroundFetch(document, position, token, relatedFiles);

    // 5. USE PREFETCHED RESULT if available
    const prefetchKey = `${uri}:${position.line}:${linePrefix}`;
    if (this.prefetchResult && this.prefetchResult.key === prefetchKey) {
        this.logger.debug('Using speculatively prefetched result');
        const res = this.prefetchResult.result;
        this.currentCompletion = res;
        this.acceptedOffset = 0;
        
        // Store in multi-file cache
        this.multiFileCache.set(uri, position, linePrefix, document.languageId, res, relatedFiles.map(f => f.toString()));
        
        // Trigger smart prefetching for next positions
        this.smartPrefetcher.schedulePrefetch(document, position, 'prefetch_hit');
        return [this.createInlineItem(res, position, document)];
    }

    return null;
  }
  
  /**
   * Get related files for cross-file context
   */
  private getRelatedFiles(document: vscode.TextDocument): vscode.Uri[] {
    const related: vscode.Uri[] = [];
    const allDocs = vscode.workspace.textDocuments;
    const currentDir = document.uri.toString().split('/').slice(0, -1).join('/');
    
    for (const doc of allDocs) {
      if (doc === document || doc.isClosed) continue;
      if (doc.languageId !== document.languageId) continue;
      
      const docDir = doc.uri.toString().split('/').slice(0, -1).join('/');
      if (docDir === currentDir || docDir.startsWith(currentDir)) {
        related.push(doc.uri);
      }
    }
    
    return related.slice(0, 5); // Limit to 5 related files
  }

  private async triggerBackgroundFetch(
      document: vscode.TextDocument,
      position: vscode.Position,
      token: vscode.CancellationToken,
      relatedFiles: vscode.Uri[] = []
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
          // Build context with cross-file awareness
          const projectContext = await this.contextEngine.buildContext(document, position, token);
          
          // Emit cross-file context loaded event
          if (relatedFiles.length > 0) {
              this.eventBus.emit({
                  type: 'cross_file_context_loaded',
                  data: { files: relatedFiles.map(f => f.toString()), totalTokens: 0 }
              });
          }

          // Check if cancelled during context build
          if (controller.signal.aborted || token.isCancellationRequested) {
              return;
          }

          const completion = await this.predictionEngine.getCompletion(document, position, projectContext, token, (partialText) => {
              // PARTIAL UPDATE: Store in cache and re-trigger
              const partialResult: CompletionResult = {
                  id: fetchKey,
                  text: partialText,
                  insertText: partialText,
                  range: new vscode.Range(position, position),
                  confidence: 0.5,
                  source: 'streaming',
                  metadata: { cached: false }
              };
              
              this.multiFileCache.set(
                  document.uri.toString(),
                  position,
                  linePrefix,
                  document.languageId,
                  partialResult,
                  relatedFiles.map(f => f.toString())
              );

              // Re-trigger VS Code to show the new partial text
              vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
          });

          if (completion && !token.isCancellationRequested && !controller.signal.aborted) {
              this.prefetchResult = { key: fetchKey, result: completion };
              
              // Store final result in cache
              this.multiFileCache.set(
                  document.uri.toString(),
                  position,
                  linePrefix,
                  document.languageId,
                  completion,
                  relatedFiles.map(f => f.toString())
              );
              
              // Schedule smart prefetch for next positions
              this.smartPrefetcher.schedulePrefetch(document, position, 'background_fetch');
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
    // Delegate to smart prefetcher for advanced prefetching
    this.smartPrefetcher.schedulePrefetch(document, currentPosition, 'completion_shown');
  }

  clearState(): void {
    // Abort any in-flight requests
    for (const controller of this.inFlightFetches.values()) {
      controller.abort();
    }
    this.inFlightFetches.clear();

    // Clear all caches and prefetchers
    this.multiFileCache.clear();
    this.smartPrefetcher.cancelAll();
    
    this.currentCompletion = null;
    this.acceptedOffset = 0;
    this.lastPosition = null;
    this.prefetchResult = null;
    this.logger.info('Completion provider state cleared');
  }
  
  /**
   * Dispose all resources
   */
  dispose(): void {
    this.clearState();
    this.proactiveSuggester.dispose();
    this.smartPrefetcher.dispose();
    this.logger.info('Completion provider disposed');
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
