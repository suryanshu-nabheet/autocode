/**
 * AutoCode Proactive Suggester
 * 
 * Triggers intelligent completions proactively, not just when typing:
 * - After brief idle periods (reading/thinking)
 * - At strategic cursor positions (end of statements, blank lines)
 * - When context changes significantly in related files
 * - Predictive: next likely edit locations based on patterns
 */

import * as vscode from 'vscode';
import { EventBus } from '../core/event-bus';
import { Logger } from '../core/logger';
import { ConfigManager } from '../core/config';
import { MultiFileCache } from '../cache/multi-file-cache';

interface ProactiveTrigger {
  type: 'idle' | 'pattern_match' | 'cross_file_change' | 'line_end' | 'blank_line' | 'after_accept';
  position: vscode.Position;
  confidence: number;
  reason: string;
}

interface CursorHistoryEntry {
  position: vscode.Position;
  timestamp: number;
  lineText: string;
  action: 'type' | 'move' | 'idle' | 'accept';
}

export class ProactiveSuggester implements vscode.Disposable {
  private logger = Logger.getInstance();
  private eventBus = EventBus.getInstance();
  private config = ConfigManager.getInstance();
  private disposables: vscode.Disposable[] = [];
  
  // Idle detection
  private idleTimer: NodeJS.Timeout | null = null;
  private lastActivity = Date.now();
  private readonly IDLE_THRESHOLD_MS = 800; // Trigger after 800ms idle
  
  // Cursor history for pattern detection
  private cursorHistory: CursorHistoryEntry[] = [];
  private readonly HISTORY_SIZE = 50;
  
  // Pattern-based prediction
  private editPatterns = new Map<string, number>(); // pattern -> frequency
  
  // Related file watcher
  private relatedFileWatcher: vscode.FileSystemWatcher | null = null;
  private currentFileUri: string | null = null;
  
  // Trigger debounce
  private triggerDebounce: NodeJS.Timeout | null = null;
  private lastTriggerPosition: vscode.Position | null = null;

  constructor(
    private multiFileCache: MultiFileCache,
    private triggerCompletion: (position: vscode.Position) => void
  ) {
    this.setupEventListeners();
    this.setupIdleDetection();
    this.setupPatternTracking();
  }

  private setupEventListeners(): void {
    // Track completion acceptance for next-line suggestions
    this.eventBus.on('completion_accepted', (event) => {
      if ('partial' in event.data && !event.data.partial) {
        this.onCompletionAccepted();
      }
    });

    // Monitor cross-file changes
    this.eventBus.on('file_modified', (event) => {
      if ('uri' in event.data && event.data.uri !== this.currentFileUri) {
        this.onRelatedFileChanged(event.data.uri);
      }
    });

    // Track cursor idle
    this.eventBus.on('cursor_idle', (event) => {
      if ('position' in event.data && 'durationMs' in event.data) {
        if (event.data.durationMs >= this.IDLE_THRESHOLD_MS) {
          this.evaluateIdleTrigger(event.data.position);
        }
      }
    });
  }

  private setupIdleDetection(): void {
    // Hook into editor selection changes
    const disposable = vscode.window.onDidChangeTextEditorSelection((e) => {
      this.onCursorActivity(e.selections[0].active, e.textEditor.document);
    });
    this.disposables.push(disposable);
  }

  private setupPatternTracking(): void {
    // Track common edit patterns
    const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
      this.onDocumentChange(e);
    });
    this.disposables.push(disposable);
  }

  /**
   * Called when cursor moves or typing happens
   */
  private onCursorActivity(position: vscode.Position, document: vscode.TextDocument): void {
    this.currentFileUri = document.uri.toString();
    this.lastActivity = Date.now();
    
    // Clear idle timer
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    // Record cursor position
    const lineText = document.lineAt(position.line).text;
    this.recordCursorHistory({
      position,
      timestamp: Date.now(),
      lineText,
      action: 'move'
    });

    // Check for strategic positions
    const strategic = this.checkStrategicPosition(position, document);
    if (strategic.shouldTrigger && strategic.confidence > 0.7) {
      this.scheduleProactiveTrigger(strategic, position);
    }

    // Start idle timer
    this.idleTimer = setTimeout(() => {
      this.eventBus.emit({
        type: 'cursor_idle',
        data: { 
          file: document.uri.toString(),
          position,
          durationMs: this.IDLE_THRESHOLD_MS
        }
      });
    }, this.IDLE_THRESHOLD_MS);
  }

  /**
   * Evaluate whether to trigger after idle period
   */
  private evaluateIdleTrigger(position: vscode.Position): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const doc = editor.document;
    const lineText = doc.lineAt(position.line).text;
    const prefix = lineText.substring(0, position.character).trim();

    // Don't trigger if:
    // - Line is empty and no recent completions
    // - In the middle of a word
    // - Just triggered recently
    if (this.recentlyTriggered(position)) return;
    if (this.isInMiddleOfWord(position, doc)) return;
    
    // Trigger conditions with confidence scores
    let trigger: ProactiveTrigger | null = null;

    // After statement (semicolon, closing brace)
    if (/[;}]\s*$/.test(prefix)) {
      trigger = {
        type: 'line_end',
        position,
        confidence: 0.85,
        reason: 'After statement completion'
      };
    }
    // Blank line with context above
    else if (prefix === '' && position.line > 0) {
      const prevLine = doc.lineAt(position.line - 1).text.trim();
      if (prevLine.length > 0 && !prevLine.startsWith('//')) {
        trigger = {
          type: 'blank_line',
          position,
          confidence: 0.75,
          reason: 'Blank line after code'
        };
      }
    }
    // Partial identifier that might complete
    else if (prefix.length > 2 && /[a-zA-Z_][a-zA-Z0-9_]*$/.test(prefix)) {
      const identifier = prefix.match(/[a-zA-Z_][a-zA-Z0-9_]*$/)![0];
      if (identifier.length >= 3) {
        trigger = {
          type: 'pattern_match',
          position,
          confidence: 0.70,
          reason: `Partial identifier: ${identifier}`
        };
      }
    }

    if (trigger && trigger.confidence >= 0.70) {
      this.logger.debug('Proactive trigger', { type: trigger.type, confidence: trigger.confidence });
      this.eventBus.emit({
        type: 'proactive_suggestion',
        data: { trigger: trigger.type, file: doc.uri.toString() }
      });
      this.triggerCompletion(position);
      this.lastTriggerPosition = position;
    }
  }

  /**
   * Called when user accepts a full completion - suggest next line
   */
  private onCompletionAccepted(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const position = editor.selection.active;
    const doc = editor.document;

    // Schedule next-line suggestion after brief delay
    setTimeout(() => {
      // Move to end of current line
      const line = doc.lineAt(position.line);
      const endOfLine = new vscode.Position(position.line, line.text.length);
      
      // Check if we're at statement end
      const text = line.text.trim();
      if (/[;}]$/.test(text) || text === '' || text.startsWith('//')) {
        this.triggerCompletion(endOfLine);
        this.logger.debug('Next-line proactive suggestion triggered');
      }
    }, 100);
  }

  /**
   * Called when a related file changes - may affect current completions
   */
  private onRelatedFileChanged(changedUri: string): void {
    // Check if we have cache entries that depend on this file
    const stats = this.multiFileCache.getStats();
    
    if (stats.l1Size > 0 || stats.l2Size > 0) {
      this.logger.debug('Related file changed, cache may be affected', { uri: changedUri });
      
      // Could trigger re-validation of current suggestions
      // or pre-fetch new completions based on updated context
    }
  }

  /**
   * Check if cursor is at a strategic position for proactive suggestion
   */
  private checkStrategicPosition(
    position: vscode.Position, 
    document: vscode.TextDocument
  ): { shouldTrigger: boolean; confidence: number; type?: string } {
    const line = document.lineAt(position.line).text;
    const prefix = line.substring(0, position.character);
    const suffix = line.substring(position.character);

    // At line end with statement terminator
    if (suffix.trim() === '' && /[;}]$/.test(prefix.trim())) {
      return { shouldTrigger: true, confidence: 0.8, type: 'statement_end' };
    }

    // After opening brace (might complete block)
    if (prefix.trim().endsWith('{')) {
      return { shouldTrigger: true, confidence: 0.75, type: 'block_start' };
    }

    // In function call parentheses
    if (prefix.includes('(') && !prefix.includes(')')) {
      const openCount = (prefix.match(/\(/g) || []).length;
      const closeCount = (prefix.match(/\)/g) || []).length;
      if (openCount > closeCount && prefix.endsWith('(')) {
        return { shouldTrigger: true, confidence: 0.7, type: 'function_call' };
      }
    }

    return { shouldTrigger: false, confidence: 0 };
  }

  /**
   * Track document changes for pattern learning
   */
  private onDocumentChange(e: vscode.TextDocumentChangeEvent): void {
    for (const change of e.contentChanges) {
      const text = change.text;
      
      // Learn patterns from multi-line insertions (common structures)
      if (text.includes('\n') && text.length > 20) {
        const pattern = this.extractPattern(text);
        if (pattern) {
          const count = this.editPatterns.get(pattern) || 0;
          this.editPatterns.set(pattern, count + 1);
        }
      }
    }
  }

  /**
   * Predict next edit location based on cursor history
   */
  public predictNextLocation(): vscode.Position | null {
    if (this.cursorHistory.length < 3) return null;

    // Simple pattern: if cursor moved to end of line multiple times recently
    const recent = this.cursorHistory.slice(-5);
    const endOfLineMoves = recent.filter(h => 
      h.action === 'move' && 
      h.lineText && 
      h.position.character >= h.lineText.length - 1
    );

    if (endOfLineMoves.length >= 2) {
      // User is navigating to line ends - predict next line end
      const last = recent[recent.length - 1];
      if (last) {
        // Would need document access to compute accurately
        return null;
      }
    }

    return null;
  }

  /**
   * Get current edit patterns for analysis
   */
  public getTopPatterns(n: number = 10): Array<{ pattern: string; frequency: number }> {
    return Array.from(this.editPatterns.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([pattern, freq]) => ({ pattern, frequency: freq }));
  }

  private recordCursorHistory(entry: CursorHistoryEntry): void {
    this.cursorHistory.push(entry);
    if (this.cursorHistory.length > this.HISTORY_SIZE) {
      this.cursorHistory.shift();
    }
  }

  private recentlyTriggered(position: vscode.Position): boolean {
    if (!this.lastTriggerPosition) return false;
    
    const lineDiff = Math.abs(position.line - this.lastTriggerPosition.line);
    return lineDiff < 2; // Don't re-trigger within 2 lines
  }

  private isInMiddleOfWord(position: vscode.Position, doc: vscode.TextDocument): boolean {
    const line = doc.lineAt(position.line).text;
    const char = line[position.character];
    const prevChar = position.character > 0 ? line[position.character - 1] : '';
    
    // In middle if surrounded by word chars
    return /[a-zA-Z0-9_]/.test(char) && /[a-zA-Z0-9_]/.test(prevChar);
  }

  private scheduleProactiveTrigger(
    strategic: { confidence: number; type?: string },
    position: vscode.Position
  ): void {
    if (this.triggerDebounce) {
      clearTimeout(this.triggerDebounce);
    }

    this.triggerDebounce = setTimeout(() => {
      if (this.shouldTriggerAt(position)) {
        this.triggerCompletion(position);
        this.lastTriggerPosition = position;
      }
    }, 150); // Small debounce for rapid cursor movement
  }

  private shouldTriggerAt(position: vscode.Position): boolean {
    // Additional validation before triggering
    if (this.recentlyTriggered(position)) return false;
    return true;
  }

  private extractPattern(text: string): string | null {
    // Extract structural patterns
    const lines = text.split('\n');
    if (lines.length < 2) return null;

    // Pattern signature: first non-empty line
    const first = lines.find(l => l.trim());
    if (!first) return null;

    // Simplify: remove specific names, keep structure
    return first
      .replace(/[a-zA-Z_][a-zA-Z0-9_]*/g, '{id}')
      .replace(/"[^"]*"/g, '{str}')
      .replace(/'[^']*'/g, '{str}')
      .replace(/\d+/g, '{num}')
      .trim();
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.triggerDebounce) clearTimeout(this.triggerDebounce);
    this.disposables.forEach(d => d.dispose());
    this.relatedFileWatcher?.dispose();
  }
}
