/**
 * AutoCode Performance Monitor
 * 
 * Tracks and reports latency, throughput, and quality metrics.
 * Provides real-time performance dashboards in the status bar
 * and detailed logs for debugging.
 */

import * as vscode from 'vscode';
import { PerformanceMetrics } from '../core/types';
import { Logger } from '../core/logger';

interface LatencySample {
  timestamp: number;
  latencyMs: number;
  type: 'completion' | 'transformation' | 'context';
}

export class PerformanceMonitor implements vscode.Disposable {
  private logger = Logger.getInstance();
  private samples: LatencySample[] = [];
  private acceptedCount = 0;
  private dismissedCount = 0;
  private totalRequests = 0;
  private statusBarItem: vscode.StatusBarItem;
  private updateTimer: NodeJS.Timeout | null = null;
  private readonly MAX_SAMPLES = 1000;
  private readonly WINDOW_MS = 5 * 60 * 1000; // 5-minute rolling window

  constructor() {
    // Create status bar item
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = 'autocode.openSettings';
    this.updateStatusBar();
    this.statusBarItem.show();

    // Periodic status bar update
    this.updateTimer = setInterval(() => this.updateStatusBar(), 5000);
  }

  /**
   * Record a latency sample
   */
  recordLatency(type: LatencySample['type'], latencyMs: number): void {
    this.samples.push({
      timestamp: Date.now(),
      latencyMs,
      type,
    });

    // Trim old samples
    if (this.samples.length > this.MAX_SAMPLES) {
      this.samples = this.samples.slice(-this.MAX_SAMPLES);
    }

    this.totalRequests++;
    this.updateStatusBar();
  }

  /** Record an accepted completion */
  recordAccepted(): void {
    this.acceptedCount++;
  }

  /** Record a dismissed completion */
  recordDismissed(): void {
    this.dismissedCount++;
  }

  /**
   * Get comprehensive performance metrics
   */
  getMetrics(): PerformanceMetrics {
    const windowStart = Date.now() - this.WINDOW_MS;
    const recentSamples = this.samples.filter(
      (s) => s.timestamp > windowStart
    );

    if (recentSamples.length === 0) {
      return {
        averageLatencyMs: 0,
        p50LatencyMs: 0,
        p95LatencyMs: 0,
        p99LatencyMs: 0,
        totalRequests: this.totalRequests,
        cacheHitRate: 0,
        averageContextTokens: 0,
        completionsAccepted: this.acceptedCount,
        completionsDismissed: this.dismissedCount,
        acceptanceRate: this.getAcceptanceRate(),
      };
    }

    const latencies = recentSamples
      .map((s) => s.latencyMs)
      .sort((a, b) => a - b);

    return {
      averageLatencyMs:
        latencies.reduce((sum, l) => sum + l, 0) / latencies.length,
      p50LatencyMs: this.percentile(latencies, 50),
      p95LatencyMs: this.percentile(latencies, 95),
      p99LatencyMs: this.percentile(latencies, 99),
      totalRequests: this.totalRequests,
      cacheHitRate: 0, // Filled by cache module
      averageContextTokens: 0, // Filled by context module
      completionsAccepted: this.acceptedCount,
      completionsDismissed: this.dismissedCount,
      acceptanceRate: this.getAcceptanceRate(),
    };
  }

  /**
   * Update the status bar with current stats
   */
  private updateStatusBar(): void {
    const metrics = this.getMetrics();
    const avgLatency = Math.round(metrics.averageLatencyMs);
    const acceptRate = Math.round(metrics.acceptanceRate * 100);

    this.statusBarItem.text = `AutoCode ${avgLatency}ms`;
    this.statusBarItem.tooltip = [
      `AutoCode Engine Status`,
      `------------------`,
      `Avg Latency: ${avgLatency}ms`,
      `P95 Latency: ${Math.round(metrics.p95LatencyMs)}ms`,
      `Requests: ${metrics.totalRequests}`,
      `Accepted: ${metrics.completionsAccepted}`,
      `Dismissed: ${metrics.completionsDismissed}`,
      `Acceptance Rate: ${acceptRate}%`,
    ].join('\n');
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) {return 0;}
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  private getAcceptanceRate(): number {
    const total = this.acceptedCount + this.dismissedCount;
    return total > 0 ? this.acceptedCount / total : 0;
  }

  reset(): void {
    this.samples = [];
    this.acceptedCount = 0;
    this.dismissedCount = 0;
    this.totalRequests = 0;
    this.updateStatusBar();
    this.logger.info('Performance metrics reset');
  }

  dispose(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }
    this.statusBarItem.dispose();
  }
}
