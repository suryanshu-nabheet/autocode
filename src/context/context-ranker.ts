/**
 * AutoCode Context Ranker
 *
 * Ranks and compresses context to fit within the model's token budget.
 * Incorporates a real feedback loop based on which context sources were present in accepted completions.
 */

import { ProjectContext } from '../core/types';
import { Logger } from '../core/logger';
import { EventBus } from '../core/event-bus';

interface ContextSourceInfo {
  weight: number;
  present: boolean;
  tokenEstimate: number;
}

interface ContextSnapshot {
  sources: Map<string, ContextSourceInfo>;
  totalTokens: number;
}

export class ContextRanker {
  private logger = Logger.getInstance();
  private weights = new Map<string, number>();
  private lastContextSnapshot: ContextSnapshot | null = null;

  constructor() {
    this.initWeights();
    this.setupFeedbackLoop();
  }

  private initWeights() {
    // Initial weights based on importance
    this.weights.set('diagnosticSummary', 1.0);   // High: fixes errors
    this.weights.set('currentFile', 0.95);       // Always included
    this.weights.set('resolvedDefinitions', 0.9); // Type info is critical
    this.weights.set('resolvedSignatures', 0.85);
    this.weights.set('symbols', 0.8);
    this.weights.set('importSuggestions', 0.75);
    this.weights.set('fileHistory', 0.7);
    this.weights.set('symbolUsages', 0.65);
    this.weights.set('projectRelationships', 0.6);
    this.weights.set('relatedFiles', 0.5);
    this.weights.set('openFiles', 0.4);
    this.weights.set('gitDiffs', 0.3);
  }

  private setupFeedbackLoop() {
    EventBus.getInstance().on('completion_accepted', () => {
      if (!this.lastContextSnapshot) {return;}

      // Boost weights of sources that were present when completion was accepted
      const sources = this.lastContextSnapshot.sources;
      sources.forEach((info, source) => {
        if (info.present) {
          const current = this.weights.get(source) || 0.5;
          const boost = 0.02; // 2% boost per acceptance
          this.weights.set(source, Math.min(1.5, current + boost));
        }
      });

      this.logger.debug('Updated context weights based on acceptance', this.getWeights());
    });

    EventBus.getInstance().on('completion_dismissed', () => {
      if (!this.lastContextSnapshot) {return;}

      // Slightly reduce weights of sources that were present when completion was dismissed
      const sources = this.lastContextSnapshot.sources;
      sources.forEach((info, source) => {
        if (info.present) {
          const current = this.weights.get(source) || 0.5;
          const penalty = 0.01; // 1% penalty per dismissal
          this.weights.set(source, Math.max(0.1, current - penalty));
        }
      });
    });
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private analyzeContext(context: ProjectContext): ContextSnapshot {
    const sources = new Map<string, ContextSourceInfo>();

    const addSource = (name: string, content: string | any[] | undefined) => {
      const present = content !== undefined && content !== null && content !== '' &&
        (Array.isArray(content) ? content.length > 0 : true);
      const text = Array.isArray(content) ? content.join('\n') : String(content || '');
      sources.set(name, {
        weight: this.weights.get(name) || 0.5,
        present: !!present,
        tokenEstimate: present ? this.estimateTokens(text) : 0,
      });
    };

    addSource('diagnosticSummary', context.diagnosticSummary);
    addSource('currentFile', context.currentFile.precedingLines + context.currentFile.followingLines);
    addSource('resolvedDefinitions', context.resolvedDefinitions);
    addSource('resolvedSignatures', context.resolvedSignatures?.join('\n'));
    addSource('symbols', context.symbols);
    addSource('importSuggestions', context.importSuggestions);
    addSource('fileHistory', context.fileHistory);
    addSource('symbolUsages', context.symbolUsages);
    addSource('projectRelationships', context.projectRelationships);
    addSource('relatedFiles', context.relatedFiles);
    addSource('openFiles', context.openFiles);
    addSource('gitDiffs', context.gitDiffs);

    const totalTokens = Array.from(sources.values())
      .filter(s => s.present)
      .reduce((sum, s) => sum + s.tokenEstimate, 0);

    return { sources, totalTokens };
  }

  /**
   * Rank and compress the context based on current weights and token budget.
   */
  public rankAndCompress(context: ProjectContext, maxTokens: number): ProjectContext {
    const snapshot = this.analyzeContext(context);
    this.lastContextSnapshot = snapshot;

    // Sort sources by weight (descending) to prioritize high-value context
    const sortedSources = Array.from(snapshot.sources.entries())
      .filter(([, info]) => info.present)
      .sort((a, b) => b[1].weight - a[1].weight);

    let currentTokens = 0;
    const includedSources = new Set<string>();

    // Greedy inclusion by weight until budget exhausted
    for (const [name, info] of sortedSources) {
      if (currentTokens + info.tokenEstimate <= maxTokens * 0.9) { // Leave 10% buffer
        includedSources.add(name);
        currentTokens += info.tokenEstimate;
      }
    }

    this.logger.debug(`Context compression: ${snapshot.totalTokens} -> ${currentTokens} tokens, sources: ${includedSources.size}/${sortedSources.length}`);

    // Build compressed context with only included sources
    const compressed: ProjectContext = {
      ...context,
      relatedFiles: includedSources.has('relatedFiles') ? context.relatedFiles.slice(0, 3) : [],
      openFiles: includedSources.has('openFiles') ? context.openFiles.slice(0, 2) : [],
      gitDiffs: includedSources.has('gitDiffs') ? context.gitDiffs.slice(0, 2) : [],
      symbols: includedSources.has('symbols') ? context.symbols.slice(0, 30) : [],
      resolvedSignatures: includedSources.has('resolvedSignatures') ? context.resolvedSignatures : [],
      fileHistory: includedSources.has('fileHistory') ? context.fileHistory : '',
      symbolUsages: includedSources.has('symbolUsages') ? context.symbolUsages : '',
      projectRelationships: includedSources.has('projectRelationships') ? context.projectRelationships : '',
    };

    // Mark which sources were actually included in the snapshot
    snapshot.sources.forEach((info, name) => {
      info.present = includedSources.has(name);
    });

    return compressed;
  }

  public getWeights(): Record<string, number> {
    const result: Record<string, number> = {};
    this.weights.forEach((w, k) => result[k] = Math.round(w * 100) / 100);
    return result;
  }
}
