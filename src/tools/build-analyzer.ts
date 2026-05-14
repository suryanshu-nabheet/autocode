/**
 * AutoCode Build Analyzer Tool
 * 
 * Advanced tooling for analyzing, optimizing, and building the AutoCode extension itself.
 * Provides insights into:
 * - Performance bottlenecks
 * - Context coverage across files
 * - Cache efficiency
 * - Model usage patterns
 * - Extension build health
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { EventBus } from '../core/event-bus';
import { Logger } from '../core/logger';
import { MultiFileCache } from '../cache/multi-file-cache';

interface BuildMetrics {
  timestamp: number;
  cacheStats: {
    l1HitRate: number;
    l2HitRate: number;
    crossFileHits: number;
    totalEntries: number;
  };
  performance: {
    avgLatencyMs: number;
    p95LatencyMs: number;
    proactiveTriggers: number;
    prefetchHitRate: number;
  };
  context: {
    avgTokensPerRequest: number;
    filesInContext: number;
    crossFileRatio: number;
  };
  completions: {
    totalGenerated: number;
    accepted: number;
    dismissed: number;
    acceptanceRate: number;
  };
}

interface OptimizationSuggestion {
  category: 'cache' | 'performance' | 'context' | 'config';
  severity: 'high' | 'medium' | 'low';
  message: string;
  action: string;
  impact: string;
}

interface FileAnalysis {
  uri: string;
  languageId: string;
  lineCount: number;
  importCount: number;
  exportCount: number;
  functionCount: number;
  complexity: number;
  lastModified: number;
}

export class BuildAnalyzer implements vscode.Disposable {
  private logger = Logger.getInstance();
  private eventBus = EventBus.getInstance();
  private disposables: vscode.Disposable[] = [];
  
  private metrics: BuildMetrics[] = [];
  private readonly MAX_METRICS_HISTORY = 100;
  
  // Real-time stats accumulation
  private sessionStats = {
    completionsGenerated: 0,
    completionsAccepted: 0,
    completionsDismissed: 0,
    totalLatencyMs: 0,
    proactiveTriggers: 0,
    crossFileCacheHits: 0,
    contextTokensTotal: 0,
    contextRequests: 0
  };

  constructor(private multiFileCache: MultiFileCache) {
    this.setupEventTracking();
    this.registerCommands();
  }

  private setupEventTracking(): void {
    // Track completion lifecycle
    this.eventBus.on('completion_shown', () => {
      this.sessionStats.completionsGenerated++;
    });

    this.eventBus.on('completion_accepted', () => {
      this.sessionStats.completionsAccepted++;
    });

    this.eventBus.on('completion_dismissed', () => {
      this.sessionStats.completionsDismissed++;
    });

    this.eventBus.on('proactive_suggestion', () => {
      this.sessionStats.proactiveTriggers++;
    });

    this.eventBus.on('cache_hit', (event) => {
      if ('crossFile' in event.data && event.data.crossFile) {
        this.sessionStats.crossFileCacheHits++;
      }
    });

    this.eventBus.on('context_rebuilt', (event) => {
      if ('tokenCount' in event.data) {
        this.sessionStats.contextTokensTotal += event.data.tokenCount;
        this.sessionStats.contextRequests++;
      }
    });
  }

  private registerCommands(): void {
    // Register VS Code commands for build analysis
    this.disposables.push(
      vscode.commands.registerCommand('autocode.analyzeBuild', () => {
        this.showBuildReport();
      })
    );

    this.disposables.push(
      vscode.commands.registerCommand('autocode.optimizeExtension', () => {
        this.runOptimizationAnalysis();
      })
    );

    this.disposables.push(
      vscode.commands.registerCommand('autocode.analyzeProjectFiles', () => {
        this.analyzeWorkspaceFiles();
      })
    );

    // AUTO-OPTIMIZATION: Background loop
    setInterval(() => this.autoOptimize(), 60000); // Every minute
  }

  /**
   * Automatically adjust configuration based on live performance metrics
   */
  private async autoOptimize(): Promise<void> {
      const metrics = this.collectMetrics();
      const config = vscode.workspace.getConfiguration('autocode');
      
      // 1. If latency is high, reduce context tokens to speed up
      if (metrics.performance.avgLatencyMs > 1000) {
          const currentTokens = config.get<number>('maxContextTokens', 2048);
          if (currentTokens > 1024) {
              await config.update('maxContextTokens', Math.max(1024, currentTokens - 256), true);
              this.logger.info(`Auto-optimized: Reduced maxContextTokens to ${currentTokens - 256} due to high latency`);
          }
      }
      
      // 2. If cache hit rate is high, we can afford more context
      if (metrics.cacheStats.l1HitRate > 0.6) {
          const currentTokens = config.get<number>('maxContextTokens', 2048);
          if (currentTokens < 4096) {
              await config.update('maxContextTokens', currentTokens + 128, true);
          }
      }

      // 3. Enable streaming if not active but latency is high
      if (metrics.performance.avgLatencyMs > 500 && !config.get('streamingEnabled')) {
          await config.update('streamingEnabled', true, true);
      }
  }

  /**
   * Collect current metrics and store in history
   */
  public collectMetrics(): BuildMetrics {
    const cacheStats = this.multiFileCache.getStats();
    
    const avgLatency = this.sessionStats.completionsGenerated > 0
      ? this.sessionStats.totalLatencyMs / this.sessionStats.completionsGenerated
      : 0;

    const avgTokens = this.sessionStats.contextRequests > 0
      ? this.sessionStats.contextTokensTotal / this.sessionStats.contextRequests
      : 0;

    const acceptanceRate = this.sessionStats.completionsGenerated > 0
      ? this.sessionStats.completionsAccepted / this.sessionStats.completionsGenerated
      : 0;

    const metrics: BuildMetrics = {
      timestamp: Date.now(),
      cacheStats: {
        l1HitRate: cacheStats.l1Hits / (cacheStats.l1Hits + cacheStats.misses) || 0,
        l2HitRate: cacheStats.l2Hits / (cacheStats.l2Hits + cacheStats.misses) || 0,
        crossFileHits: cacheStats.crossFileHits,
        totalEntries: cacheStats.l1Size + cacheStats.l2Size
      },
      performance: {
        avgLatencyMs: avgLatency,
        p95LatencyMs: this.estimateP95Latency(),
        proactiveTriggers: this.sessionStats.proactiveTriggers,
        prefetchHitRate: this.estimatePrefetchHitRate()
      },
      context: {
        avgTokensPerRequest: avgTokens,
        filesInContext: this.estimateFilesInContext(),
        crossFileRatio: this.estimateCrossFileRatio()
      },
      completions: {
        totalGenerated: this.sessionStats.completionsGenerated,
        accepted: this.sessionStats.completionsAccepted,
        dismissed: this.sessionStats.completionsDismissed,
        acceptanceRate
      }
    };

    this.metrics.push(metrics);
    if (this.metrics.length > this.MAX_METRICS_HISTORY) {
      this.metrics.shift();
    }

    return metrics;
  }

  /**
   * Generate optimization suggestions based on current state
   */
  public analyzeOptimizations(): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = [];
    const metrics = this.collectMetrics();

    // Cache optimizations
    if (metrics.cacheStats.l1HitRate < 0.3) {
      suggestions.push({
        category: 'cache',
        severity: 'high',
        message: 'L1 cache hit rate is low (< 30%)',
        action: 'Consider increasing cache TTL or reducing context sensitivity',
        impact: 'Reduce model API calls by 40-60%'
      });
    }

    if (metrics.cacheStats.crossFileHits === 0 && metrics.completions.totalGenerated > 10) {
      suggestions.push({
        category: 'cache',
        severity: 'medium',
        message: 'No cross-file cache hits detected',
        action: 'Enable cross-file context sharing for similar patterns',
        impact: 'Improve cache reuse across related files'
      });
    }

    // Performance optimizations
    if (metrics.performance.avgLatencyMs > 500) {
      suggestions.push({
        category: 'performance',
        severity: 'high',
        message: `Average latency is high (${metrics.performance.avgLatencyMs.toFixed(0)}ms)`,
        action: 'Enable streaming, reduce max tokens, or use faster model',
        impact: 'Sub-second response times'
      });
    }

    if (metrics.performance.proactiveTriggers === 0 && metrics.completions.totalGenerated > 5) {
      suggestions.push({
        category: 'performance',
        severity: 'medium',
        message: 'Proactive suggestions not triggering',
        action: 'Lower idle threshold or enable strategic position detection',
        impact: 'More responsive completion experience'
      });
    }

    // Context optimizations
    if (metrics.context.avgTokensPerRequest > 4000) {
      suggestions.push({
        category: 'context',
        severity: 'medium',
        message: `High token usage per request (${metrics.context.avgTokensPerRequest.toFixed(0)} tokens)`,
        action: 'Reduce maxContextTokens or enable context compression',
        impact: 'Lower API costs and faster responses'
      });
    }

    // Config optimizations
    if (metrics.completions.acceptanceRate < 0.3 && metrics.completions.totalGenerated > 20) {
      suggestions.push({
        category: 'config',
        severity: 'high',
        message: `Low acceptance rate (${(metrics.completions.acceptanceRate * 100).toFixed(1)}%)`,
        action: 'Adjust temperature, enable style learning, or refine prompt',
        impact: 'Higher quality completions'
      });
    }

    return suggestions.sort((a, b) => {
      const severityOrder = { high: 0, medium: 1, low: 2 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    });
  }

  /**
   * Analyze workspace files for context coverage
   */
  public async analyzeWorkspaceFiles(): Promise<FileAnalysis[]> {
    const analyses: FileAnalysis[] = [];
    const files = await vscode.workspace.findFiles(
      '**/*.{ts,tsx,js,jsx,py,java,go,rs}',
      '**/node_modules/**'
    );

    for (const file of files.slice(0, 50)) { // Limit to 50 files
      try {
        const doc = await vscode.workspace.openTextDocument(file);
        const text = doc.getText();
        
        const analysis: FileAnalysis = {
          uri: file.toString(),
          languageId: doc.languageId,
          lineCount: doc.lineCount,
          importCount: (text.match(/^(import|require|from|#include)/gm) || []).length,
          exportCount: (text.match(/^export\s/gm) || []).length,
          functionCount: (text.match(/\bfunction\s|=>\s*\{|\b(def|fn)\s/g) || []).length,
          complexity: this.estimateComplexity(text),
          lastModified: 0 // Would need file system access
        };

        analyses.push(analysis);
      } catch (err) {
        // Skip files that can't be analyzed
      }
    }

    return analyses.sort((a, b) => b.complexity - a.complexity);
  }

  /**
   * Show build report webview panel
   */
  private async showBuildReport(): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      'autocodeBuildReport',
      'AutoCode Build Report',
      vscode.ViewColumn.One,
      { enableScripts: true }
    );

    const metrics = this.collectMetrics();
    const suggestions = this.analyzeOptimizations();
    const fileAnalysis = await this.analyzeWorkspaceFiles();

    panel.webview.html = this.generateReportHtml(metrics, suggestions, fileAnalysis);
  }

  /**
   * Run optimization analysis and show results
   */
  private async runOptimizationAnalysis(): Promise<void> {
    const suggestions = this.analyzeOptimizations();
    
    if (suggestions.length === 0) {
      vscode.window.showInformationMessage('AutoCode is running optimally!');
      return;
    }

    const items = suggestions.map(s => ({
      label: `$(warning) ${s.message}`,
      description: `[${s.severity.toUpperCase()}] ${s.category}`,
      detail: `Action: ${s.action} | Impact: ${s.impact}`,
      suggestion: s
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select an optimization to apply',
      canPickMany: false
    });

    if (selected) {
      // Apply optimization
      await this.applyOptimization(selected.suggestion);
    }
  }

  private async applyOptimization(suggestion: OptimizationSuggestion): Promise<void> {
    const config = vscode.workspace.getConfiguration('autocode');
    
    switch (suggestion.category) {
      case 'cache':
        await config.update('cacheTTLSeconds', 600, true);
        break;
      case 'performance':
        await config.update('streamingEnabled', true, true);
        break;
      case 'context':
        await config.update('maxContextTokens', 2048, true);
        break;
    }

    vscode.window.showInformationMessage(`Applied optimization: ${suggestion.message}`);
  }

  /**
   * Generate HTML report
   */
  private generateReportHtml(
    metrics: BuildMetrics,
    suggestions: OptimizationSuggestion[],
    fileAnalysis: FileAnalysis[]
  ): string {
    const formatPercent = (n: number) => (n * 100).toFixed(1) + '%';
    const formatNumber = (n: number) => n.toLocaleString();

    return `<!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: system-ui, sans-serif; padding: 20px; background: #1e1e1e; color: #d4d4d4; }
        h1, h2 { color: #4ec9b0; }
        .metric-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin: 20px 0; }
        .metric-card { background: #252526; padding: 15px; border-radius: 6px; border-left: 3px solid #0e639c; }
        .metric-value { font-size: 24px; font-weight: bold; color: #fff; }
        .metric-label { font-size: 12px; color: #858585; margin-top: 5px; }
        .suggestion { background: #252526; padding: 12px; margin: 10px 0; border-radius: 4px; border-left: 3px solid #cca700; }
        .suggestion.high { border-left-color: #f44747; }
        .file-row { display: flex; justify-content: space-between; padding: 8px; border-bottom: 1px solid #333; }
        .good { color: #73c991; }
        .warning { color: #cca700; }
        .bad { color: #f44747; }
      </style>
    </head>
    <body>
      <h1>AutoCode Build Report</h1>
      
      <h2>Performance Metrics</h2>
      <div class="metric-grid">
        <div class="metric-card">
          <div class="metric-value">${metrics.performance.avgLatencyMs.toFixed(0)}ms</div>
          <div class="metric-label">Avg Latency</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">${formatPercent(metrics.cacheStats.l1HitRate)}</div>
          <div class="metric-label">L1 Cache Hit Rate</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">${formatPercent(metrics.completions.acceptanceRate)}</div>
          <div class="metric-label">Acceptance Rate</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">${formatNumber(metrics.completions.totalGenerated)}</div>
          <div class="metric-label">Completions Generated</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">${formatNumber(metrics.cacheStats.totalEntries)}</div>
          <div class="metric-label">Cache Entries</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">${formatNumber(metrics.context.avgTokensPerRequest)}</div>
          <div class="metric-label">Avg Tokens/Request</div>
        </div>
      </div>

      <h2>Optimization Suggestions (${suggestions.length})</h2>
      ${suggestions.map(s => `
        <div class="suggestion ${s.severity}">
          <strong>[${s.severity.toUpperCase()}] ${s.category}</strong>: ${s.message}
          <br/><em>Action:</em> ${s.action}
          <br/><em>Impact:</em> ${s.impact}
        </div>
      `).join('')}

      <h2>File Analysis (Top ${fileAnalysis.length})</h2>
      ${fileAnalysis.slice(0, 10).map(f => `
        <div class="file-row">
          <span>${f.uri.split('/').pop()}</span>
          <span class="${f.complexity > 50 ? 'bad' : f.complexity > 20 ? 'warning' : 'good'}">
            ${f.lineCount} lines | ${f.functionCount} functions | complexity: ${f.complexity}
          </span>
        </div>
      `).join('')}
    </body>
    </html>`;
  }

  // Estimation helpers
  private estimateP95Latency(): number {
    // Simplified estimation based on average
    return this.sessionStats.totalLatencyMs > 0
      ? this.sessionStats.totalLatencyMs * 1.5
      : 0;
  }

  private estimatePrefetchHitRate(): number {
    // Would need actual prefetch tracking
    return 0.7;
  }

  private estimateFilesInContext(): number {
    // Simplified: assume 3-5 files typically
    return 4;
  }

  private estimateCrossFileRatio(): number {
    const total = this.sessionStats.completionsGenerated;
    return total > 0 ? this.sessionStats.crossFileCacheHits / total : 0;
  }

  private estimateComplexity(text: string): number {
    // Simple complexity metric
    const lines = text.split('\n').length;
    const branches = (text.match(/\b(if|else|for|while|switch|case|catch)\b/g) || []).length;
    const functions = (text.match(/\bfunction\b|\b=>\b/g) || []).length;
    return Math.round((branches * 2 + functions + lines / 50) / 3);
  }

  /**
   * Export metrics to JSON file
   */
  public exportMetrics(filePath: string): void {
    const data = {
      session: this.sessionStats,
      history: this.metrics,
      timestamp: Date.now()
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
