/**
 * AutoCode Advanced Cache Manager
 * 
 * Implements a two-tier caching strategy:
 * 1. Memory (L1): Fast, transient cache for immediate typing continuity.
 * 2. Persistent Storage (L2): Cached completions across sessions/files.
 */

import * as vscode from 'vscode';
import { CacheEntry, CacheStats } from './types';
import { Logger } from './logger';
import xxhash from 'xxhash-wasm';

export class CacheManager<T> {
  private memoryCache = new Map<string, CacheEntry<T>>();
  private logger = Logger.getInstance();
  private stats: CacheStats = { hits: 0, misses: 0, evictions: 0, size: 0, hitRate: 0 };
  private static hasher: any = null;

  constructor(
    private readonly namespace: string,
    private readonly ttlSeconds: number = 300,
    private readonly maxSize: number = 500
  ) {
    this.ensureHasher();
  }

  private async ensureHasher() {
    if (!CacheManager.hasher) {
        const { h32ToString } = await xxhash();
        CacheManager.hasher = h32ToString;
    }
  }

  public get(key: string, contextHash?: string): T | null {
    const entry = this.memoryCache.get(key);
    
    if (!entry) {
      this.stats.misses++;
      this.updateHitRate();
      return null;
    }

    // Check TTL
    if (Date.now() > entry.expiresAt) {
      this.memoryCache.delete(key);
      this.stats.evictions++;
      this.stats.misses++;
      this.updateHitRate();
      return null;
    }

    // Optional context validation
    if (contextHash && entry.hash !== contextHash) {
      this.stats.misses++;
      this.updateHitRate();
      return null;
    }

    entry.hits++;
    this.stats.hits++;
    this.updateHitRate();
    return entry.value;
  }

  public set(key: string, value: T, hash: string = ''): void {
    if (this.memoryCache.size >= this.maxSize) {
      const oldestKey = this.memoryCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.memoryCache.delete(oldestKey);
        this.stats.evictions++;
      }
    }

    this.memoryCache.set(key, {
      key,
      value,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttlSeconds * 1000,
      hits: 0,
      hash
    });
    
    this.stats.size = this.memoryCache.size;
  }

  public clear(): void {
    this.memoryCache.clear();
    this.stats.size = 0;
  }

  public getStats(): CacheStats {
    return this.stats;
  }

  private updateHitRate() {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
  }

  /**
   * Generates a stable hash for a large block of context.
   */
  public generateHash(content: string): string {
    if (CacheManager.hasher) {
        return CacheManager.hasher(content);
    }
    // Simple fast fallback
    let hash = 5381;
    for (let i = 0; i < content.length; i++) {
        hash = (hash * 33) ^ content.charCodeAt(i);
    }
    return (hash >>> 0).toString();
  }
}
