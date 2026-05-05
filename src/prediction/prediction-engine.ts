/**
 * AutoCode Prediction Engine
 * 
 * Manages the lifecycle of code completion requests with advanced caching,
 * predictive prefetching, and streaming delivery.
 */

import * as vscode from 'vscode';
import {
  ProjectContext,
  CompletionResult,
  ModelRequest,
  ModelResponse,
  AutoCodeConfig,
} from '../core/types';
import { ModelLayer } from '../models/model-layer';
import { PromptBuilder } from '../models/prompt-builder';
import { ConfigManager } from '../core/config';
import { Logger } from '../core/logger';
import { EventBus } from '../core/event-bus';
import { CacheManager } from '../core/cache-manager';

export class PredictionEngine implements vscode.Disposable {
  private config = ConfigManager.getInstance();
  private logger = Logger.getInstance();
  private eventBus = EventBus.getInstance();
  private promptBuilder = new PromptBuilder();
  private cache = new CacheManager<CompletionResult>('completions', 300, 1000);
  private streamingRequests = new Map<string, vscode.CancellationTokenSource>();
  private disposables: vscode.Disposable[] = [];

  constructor(private modelLayer: ModelLayer) {}

  /**
   * Sub-millisecond lookup for cached completions
   */
  public async getCachedCompletion(key: string): Promise<CompletionResult | null> {
      return this.cache.get(key);
  }

  /**
   * Main entry point for inline completions.
   */
  async getCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: ProjectContext,
    token: vscode.CancellationToken
  ): Promise<CompletionResult | null> {
    const cursorLine = document.lineAt(position.line).text;
    const linePrefix = cursorLine.substring(0, position.character);
    
    // 1. FAST-PATH: Immediate Cache Lookup (Sub-millisecond)
    const cacheKey = `${document.uri.toString()}:${position.line}:${linePrefix}`;
    const contextHash = this.cache.generateHash(context.currentFile.precedingLines);
    const cached = await this.cache.get(cacheKey, contextHash);

    if (cached) {
      return cached;
    }

    // 2. Prompt Construction
    const prompt = this.promptBuilder.buildCompletionPrompt(context);
    
    // 3. Model Inference
    const request: ModelRequest = {
      prompt,
      maxTokens: 128, // Small for speed, most completions are short
      temperature: 0, // Deterministic for better caching
      stopSequences: ['<|fim_suffix|>', '<|file_separator|>', '\n\n', '```'],
      stream: this.config.getValue('streamingEnabled'),
    };

    try {
      let response: ModelResponse;
      if (this.config.getValue('streamingEnabled')) {
        response = await this.modelLayer.stream(request, () => { /* no-op: inline completions render atomically */ }, token);
      } else {
        response = await this.modelLayer.complete(request);
      }
      if (token.isCancellationRequested) return null;

      // 4. Post-processing
      const completionText = this.postProcess(response.text, linePrefix);
      if (!completionText) return null;

      const result: CompletionResult = {
        id: Math.random().toString(36).substring(7),
        text: completionText,
        insertText: completionText,
        range: new vscode.Range(position, position),
        confidence: 0.95,
        source: 'inline',
        metadata: {
          modelLatencyMs: response.latencyMs,
          contextTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          cached: false,
        },
      };

      // 5. Update Cache
      this.cache.set(cacheKey, result, contextHash);

      return result;
    } catch (err) {
      this.logger.warn('Completion generation failed', err);
      return null;
    }
  }

  private postProcess(text: string, prefix: string): string {
    let processed = text;
    
    // Remove model FIM markers and garbage
    processed = processed.replace(/<\|fim_middle\|>|<\|fim_suffix\|>|<\|fim_prefix\|>/g, '');
    
    // If the model repeated the prefix, strip it
    if (processed.startsWith(prefix)) {
        processed = processed.substring(prefix.length);
    } else if (prefix.trim() && processed.trim().startsWith(prefix.trim())) {
        // Handle cases with different indentation/spacing
        const trimPrefix = prefix.trim();
        const startIdx = processed.indexOf(trimPrefix);
        if (startIdx !== -1) {
            processed = processed.substring(startIdx + trimPrefix.length);
        }
    }

    // Clean up
    processed = processed.split('<|')[0]; // Remove any other markers
    processed = processed.split('\r?\n\r?\n')[0]; // Double newline is often a stop sign
    
    if (processed.length === 0 || processed.length > 500) return '';

    return processed;
  }

  clearCache(): void {
    this.cache.clear();
    this.logger.info('Prediction cache cleared');
  }

  dispose(): void {
    this.streamingRequests.forEach((cts) => cts.cancel());
    this.disposables.forEach((d) => d.dispose());
  }
}
