/**
 * AutoCode Smart Prefetcher
 * 
 * Predicts cursor movement patterns and pre-fetches completions:
 * - After accepting completion, prefetch next logical position
 * - When moving through code with arrow keys, prefetch ahead
 * - When clicking in likely edit zones, prefetch immediately
 * - Multi-file prefetching for related open files
 */

import * as vscode from 'vscode';
import { EventBus } from '../core/event-bus';
import { Logger } from '../core/logger';
import { MultiFileCache } from '../cache/multi-file-cache';
import { ContextEngine } from '../context/context-engine';
import { PredictionEngine } from '../prediction/prediction-engine';

interface PrefetchTarget {
  uri: string;
  position: vscode.Position;
  priority: number; // 0-1, higher = fetch first
  reason: string;
  linePrefix: string;
}

interface CursorTrajectory {
  positions: vscode.Position[];
  timestamps: number[];
  velocity: { dx: number; dy: number };
}

export class SmartPrefetcher implements vscode.Disposable {
  private logger = Logger.getInstance();
  private eventBus = EventBus.getInstance();
  private disposables: vscode.Disposable[] = [];
  
  // Pending prefetches
  private prefetchQueue: PrefetchTarget[] = [];
  private activePrefetches = new Map<string, vscode.CancellationTokenSource>();
  private readonly MAX_CONCURRENT_PREFETCHES = 3;
  private readonly MAX_QUEUE_SIZE = 10;
  
  // Cursor trajectory tracking
  private cursorHistory: Array<{ position: vscode.Position; timestamp: number }> = [];
  private readonly TRAJECTORY_SIZE = 10;
  
  // Predictive positions
  private predictedPositions = new Map<string, vscode.Position>();

  constructor(
    private multiFileCache: MultiFileCache,
    private contextEngine: ContextEngine,
    private predictionEngine: PredictionEngine
  ) {
    this.setupEventListeners();
    this.startPrefetchWorker();
  }

  private setupEventListeners(): void {
    // Prefetch after completion acceptance
    this.eventBus.on('completion_accepted', (event) => {
      if ('partial' in event.data && !event.data.partial) {
        this.prefetchAfterAccept();
      }
    });

    // Track cursor for movement prediction
    const disposable = vscode.window.onDidChangeTextEditorSelection((e) => {
      this.onCursorMove(e.selections[0].active, e.textEditor.document);
    });
    this.disposables.push(disposable);

    // Multi-file prefetching when switching tabs
    const tabDisposable = vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e) {
        this.prefetchForActiveEditor(e);
      }
    });
    this.disposables.push(tabDisposable);
  }

  /**
   * Main prefetch entry point - predicts and queues fetch targets
   */
  public schedulePrefetch(
    document: vscode.TextDocument,
    currentPosition: vscode.Position,
    reason: string = 'explicit'
  ): void {
    const targets = this.generatePrefetchTargets(document, currentPosition, reason);
    
    for (const target of targets) {
      this.queuePrefetch(target);
    }
  }

  /**
   * Generate prefetch targets based on current context and predictions
   */
  private generatePrefetchTargets(
    document: vscode.TextDocument,
    position: vscode.Position,
    reason: string
  ): PrefetchTarget[] {
    const targets: PrefetchTarget[] = [];
    const uri = document.uri.toString();

    // 1. Immediate next position (end of current completion)
    const line = document.lineAt(position.line);
    const lineEndPos = new vscode.Position(position.line, line.text.length);
    const linePrefix = line.text.substring(0, position.character);
    
    // Only if not already at end
    if (position.character < line.text.length - 1) {
      targets.push({
        uri,
        position: lineEndPos,
        priority: 0.9,
        reason: `${reason}:end_of_line`,
        linePrefix: line.text
      });
    }

    // 2. Next line (if current line ends with statement)
    if (position.line < document.lineCount - 1) {
      const nextLine = document.lineAt(position.line + 1);
      const nextLineText = nextLine.text;
      
      // Smart: if current line ends with ; or }, next line is likely target
      const currentLineText = line.text.trim();
      if (/[;}]$/.test(currentLineText) || currentLineText === '') {
        const indent = this.getIndentation(nextLineText);
        const contentStart = new vscode.Position(position.line + 1, indent.length);
        
        targets.push({
          uri,
          position: contentStart,
          priority: 0.85,
          reason: `${reason}:next_line`,
          linePrefix: nextLineText.substring(0, Math.min(30, nextLineText.length))
        });
      }
    }

    // 3. Predicted cursor position from trajectory
    const predicted = this.predictCursorPosition();
    if (predicted) {
      const { position: predPos, confidence } = predicted;
      if (confidence > 0.6) {
        const predLine = document.lineAt(predPos.line);
        targets.push({
          uri,
          position: predPos,
          priority: confidence * 0.8,
          reason: `${reason}:predicted`,
          linePrefix: predLine.text.substring(0, predPos.character)
        });
      }
    }

    // 4. Strategic positions ahead (block boundaries, function starts)
    const strategic = this.findStrategicPositions(document, position, 5);
    for (const pos of strategic) {
      const sLine = document.lineAt(pos.line);
      targets.push({
        uri,
        position: pos,
        priority: 0.6,
        reason: `${reason}:strategic`,
        linePrefix: sLine.text.substring(0, pos.character)
      });
    }

    return targets.sort((a, b) => b.priority - a.priority).slice(0, 5);
  }

  /**
   * Prefetch for related files when they become active
   */
  private async prefetchForActiveEditor(editor: vscode.TextEditor): Promise<void> {
    const document = editor.document;
    const position = editor.selection.active;
    
    // Prefetch current position immediately
    this.schedulePrefetch(document, position, 'editor_focus');

    // Find related open files
    const relatedFiles = this.findRelatedOpenFiles(document);
    
    for (const relatedDoc of relatedFiles.slice(0, 2)) {
      // Get likely edit positions in related file
      const positions = this.findLikelyEditPositions(relatedDoc);
      
      for (const pos of positions.slice(0, 2)) {
        const line = relatedDoc.lineAt(pos.line);
        this.queuePrefetch({
          uri: relatedDoc.uri.toString(),
          position: pos,
          priority: 0.5,
          reason: 'related_file',
          linePrefix: line.text.substring(0, pos.character)
        });
      }
    }
  }

  /**
   * Find related open files (same language, imports, or directory)
   */
  private findRelatedOpenFiles(currentDoc: vscode.TextDocument): vscode.TextDocument[] {
    const allDocs = vscode.workspace.textDocuments;
    const currentUri = currentDoc.uri;
    const currentDir = currentUri.toString().split('/').slice(0, -1).join('/');
    
    return allDocs.filter(doc => {
      if (doc === currentDoc) return false;
      if (doc.isClosed) return false;
      if (doc.languageId !== currentDoc.languageId) return false;
      
      const docUri = doc.uri.toString();
      const docDir = docUri.split('/').slice(0, -1).join('/');
      
      // Same directory or close
      return docDir === currentDir || docDir.startsWith(currentDir);
    });
  }

  /**
   * Find likely edit positions in a document
   */
  private findLikelyEditPositions(document: vscode.TextDocument): vscode.Position[] {
    const positions: vscode.Position[] = [];
    
    // Look for:
    // - Function definitions
    // - Empty lines after statements
    // - Unclosed braces
    
    for (let i = 0; i < Math.min(document.lineCount, 100); i++) {
      const line = document.lineAt(i);
      const text = line.text.trim();
      
      // Function/Method start
      if (/^(function|const|let|var|async|export)\s/.test(text) || 
          /^[a-zA-Z_][a-zA-Z0-9_]*\s*\(/.test(text)) {
        positions.push(new vscode.Position(i, line.text.length));
      }
      
      // After statement
      if (/[;}]$/.test(text) && i < document.lineCount - 1) {
        const nextLine = document.lineAt(i + 1);
        if (nextLine.text.trim() === '') {
          const indent = this.getIndentation(nextLine.text);
          positions.push(new vscode.Position(i + 1, indent.length));
        }
      }
    }
    
    return positions;
  }

  /**
   * Prefetch after accepting a completion
   */
  private async prefetchAfterAccept(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;
    const position = editor.selection.active;

    // Wait for editor to update
    await new Promise(r => setTimeout(r, 50));

    // Generate targets for next position
    this.schedulePrefetch(document, position, 'after_accept');
  }

  /**
   * Track cursor movement for trajectory prediction
   */
  private onCursorMove(position: vscode.Position, document: vscode.TextDocument): void {
    this.cursorHistory.push({ position, timestamp: Date.now() });
    
    if (this.cursorHistory.length > this.TRAJECTORY_SIZE) {
      this.cursorHistory.shift();
    }

    // If moving rapidly in one direction, prefetch ahead
    const trajectory = this.analyzeTrajectory();
    if (trajectory && trajectory.velocity.dy > 2) {
      // Moving down rapidly - prefetch below
      const aheadLine = Math.min(position.line + trajectory.velocity.dy, document.lineCount - 1);
      const aheadPos = new vscode.Position(aheadLine, position.character);
      
      this.queuePrefetch({
        uri: document.uri.toString(),
        position: aheadPos,
        priority: 0.7,
        reason: 'cursor_trajectory',
        linePrefix: document.lineAt(aheadLine).text.substring(0, position.character)
      });
    }
  }

  /**
   * Predict cursor position based on history
   */
  private predictCursorPosition(): { position: vscode.Position; confidence: number } | null {
    if (this.cursorHistory.length < 3) return null;

    const recent = this.cursorHistory.slice(-5);
    
    // Calculate velocity
    let dx = 0, dy = 0;
    for (let i = 1; i < recent.length; i++) {
      dx += recent[i].position.character - recent[i-1].position.character;
      dy += recent[i].position.line - recent[i-1].position.line;
    }
    
    dx = Math.round(dx / (recent.length - 1));
    dy = Math.round(dy / (recent.length - 1));

    if (dy === 0 && dx === 0) return null;

    const last = recent[recent.length - 1];
    const predicted = new vscode.Position(
      last.position.line + dy,
      Math.max(0, last.position.character + dx)
    );

    // Confidence based on consistency
    const confidence = Math.min(0.9, 0.5 + (recent.length / 10));

    return { position: predicted, confidence };
  }

  /**
   * Analyze cursor trajectory
   */
  private analyzeTrajectory(): CursorTrajectory | null {
    if (this.cursorHistory.length < 3) return null;

    const positions = this.cursorHistory.map(h => h.position);
    const timestamps = this.cursorHistory.map(h => h.timestamp);

    let dx = 0, dy = 0;
    for (let i = 1; i < positions.length; i++) {
      dx += positions[i].character - positions[i-1].character;
      dy += positions[i].line - positions[i-1].line;
    }

    return {
      positions,
      timestamps,
      velocity: { dx: dx / (positions.length - 1), dy: dy / (positions.length - 1) }
    };
  }

  /**
   * Queue a prefetch target
   */
  private queuePrefetch(target: PrefetchTarget): void {
    const key = `${target.uri}:${target.position.line}:${target.position.character}`;
    
    // Don't queue if already cached
    if (this.multiFileCache.get(target.uri, target.position, target.linePrefix, 'typescript')) {
      return;
    }

    // Don't queue if already being prefetched
    if (this.activePrefetches.has(key)) {
      return;
    }

    // Add to queue with deduplication
    const existingIndex = this.prefetchQueue.findIndex(
      t => t.uri === target.uri && 
           t.position.line === target.position.line &&
           Math.abs(t.position.character - target.position.character) < 5
    );

    if (existingIndex >= 0) {
      // Update priority if higher
      if (target.priority > this.prefetchQueue[existingIndex].priority) {
        this.prefetchQueue[existingIndex] = target;
      }
    } else {
      this.prefetchQueue.push(target);
      
      // Maintain max size
      if (this.prefetchQueue.length > this.MAX_QUEUE_SIZE) {
        this.prefetchQueue.sort((a, b) => b.priority - a.priority);
        this.prefetchQueue = this.prefetchQueue.slice(0, this.MAX_QUEUE_SIZE);
      }
    }
  }

  /**
   * Background worker that processes prefetch queue
   */
  private startPrefetchWorker(): void {
    const processQueue = async () => {
      // Process up to max concurrent
      while (
        this.prefetchQueue.length > 0 && 
        this.activePrefetches.size < this.MAX_CONCURRENT_PREFETCHES
      ) {
        // Sort by priority
        this.prefetchQueue.sort((a, b) => b.priority - a.priority);
        const target = this.prefetchQueue.shift()!;
        
        this.executePrefetch(target);
      }
    };

    // Run every 100ms
    const interval = setInterval(processQueue, 100);
    this.disposables.push(new vscode.Disposable(() => clearInterval(interval)));
  }

  /**
   * Execute a single prefetch
   */
  private async executePrefetch(target: PrefetchTarget): Promise<void> {
    const key = `${target.uri}:${target.position.line}:${target.position.character}`;
    const cts = new vscode.CancellationTokenSource();
    this.activePrefetches.set(key, cts);

    try {
      // Get document
      const uri = vscode.Uri.parse(target.uri);
      const document = await vscode.workspace.openTextDocument(uri);
      
      // Build context
      const context = await this.contextEngine.buildContext(
        document, 
        target.position, 
        cts.token
      );

      if (cts.token.isCancellationRequested) return;

      // Get completion
      const result = await this.predictionEngine.getCompletion(
        document,
        target.position,
        context,
        cts.token
      );

      if (result && !cts.token.isCancellationRequested) {
        // Store in cache
        this.multiFileCache.set(
          target.uri,
          target.position,
          target.linePrefix,
          document.languageId,
          result,
          [target.uri] // dependencies
        );
        
        this.logger.debug('Prefetched completion', { 
          uri: target.uri, 
          line: target.position.line,
          reason: target.reason
        });
      }
    } catch (err) {
      // Silent fail for prefetch
    } finally {
      this.activePrefetches.delete(key);
      cts.dispose();
    }
  }

  /**
   * Find strategic positions ahead of cursor for prefetching
   */
  private findStrategicPositions(
    document: vscode.TextDocument,
    from: vscode.Position,
    count: number
  ): vscode.Position[] {
    const positions: vscode.Position[] = [];
    let found = 0;

    for (let i = from.line + 1; i < document.lineCount && found < count; i++) {
      const line = document.lineAt(i);
      const text = line.text.trim();

      // Stop at empty section
      if (text === '' && positions.length > 0) {
        const nextLine = i < document.lineCount - 1 ? document.lineAt(i + 1).text.trim() : '';
        if (nextLine === '') continue;
      }

      // Function/class boundaries
      if (/^(function|class|interface|export|async)\s/.test(text)) {
        const indent = this.getIndentation(line.text);
        positions.push(new vscode.Position(i, indent.length));
        found++;
        continue;
      }

      // Statement after block
      if (/^[}]/.test(text)) {
        const afterBrace = text.indexOf('}') + 1;
        positions.push(new vscode.Position(i, afterBrace));
        found++;
      }
    }

    return positions;
  }

  private getIndentation(line: string): string {
    const match = line.match(/^(\s*)/);
    return match ? match[1] : '';
  }

  /**
   * Cancel all pending prefetches
   */
  public cancelAll(): void {
    this.prefetchQueue = [];
    for (const [key, cts] of this.activePrefetches) {
      cts.cancel();
    }
    this.activePrefetches.clear();
  }

  /**
   * Get prefetch statistics
   */
  public getStats(): { 
    queueSize: number; 
    activeCount: number; 
    historySize: number;
  } {
    return {
      queueSize: this.prefetchQueue.length,
      activeCount: this.activePrefetches.size,
      historySize: this.cursorHistory.length
    };
  }

  dispose(): void {
    this.cancelAll();
    this.disposables.forEach(d => d.dispose());
  }
}
