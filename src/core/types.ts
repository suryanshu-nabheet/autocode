/**
 * AutoCode Core Type Definitions
 * 
 * Central type system for the entire AutoCode engine.
 */

import * as vscode from 'vscode';

/**
 * Supported model providers.
 */
export type ModelProvider = 'openai' | 'anthropic' | 'ollama' | 'custom';

/**
 * Logging levels.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Comprehensive configuration for the AutoCode extension.
 */
export interface AutoCodeConfig {
  enabled: boolean;
  provider: ModelProvider;
  model: string;
  apiKey: string;
  apiEndpoint: string;
  maxContextTokens: number;
  debounceMs: number;
  prefetchEnabled: boolean;
  maxCompletionLines: number;
  streamingEnabled: boolean;
  cacheEnabled: boolean;
  cacheTTLSeconds: number;
  styleLearnEnabled: boolean;
  telemetryEnabled: boolean;
  logLevel: LogLevel;
  maxTokens: number;
}

/**
 * Metadata and content snapshot for a file in the workspace.
 */
export interface FileContext {
  uri: vscode.Uri;
  relativePath: string;
  languageId: string;
  content: string;
  version: number;
  lineCount: number;
  diagnostics?: any[];
}

/**
 * Granular context around the current cursor position.
 */
export interface CursorContext {
  file: FileContext;
  position: vscode.Position;
  linePrefix: string;
  lineSuffix: string;
  precedingLines: string;
  followingLines: string;
  selectedText?: string;
  indentation: string;
}

/**
 * Information about a project symbol (class, function, variable, etc.).
 */
export interface SymbolInfo {
  name: string;
  kind: vscode.SymbolKind;
  range: vscode.Range;
  containerName?: string;
  detail?: string;
  filePath: string;
}

/**
 * Information about a module import.
 */
export interface ImportInfo {
  moduleName: string;
  importedSymbols: string[];
  isDefault: boolean;
  isNamespace: boolean;
  filePath: string;
  resolvedPath?: string;
}

/**
 * Represents a set of changes in a file from Git perspective.
 */
export interface GitDiff {
  filePath: string;
  hunks: Array<{
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    content: string;
  }>;
}

/**
 * Full project context used as input for completions.
 */
export interface ProjectContext {
  currentFile: CursorContext;
  openFiles: FileContext[];
  relatedFiles: FileContext[];
  symbols: SymbolInfo[];
  imports: ImportInfo[];
  gitDiffs: GitDiff[];
  recentEdits: EditEvent[];
  projectStyle: ProjectStyle;
  resolvedSignatures?: string[];
  diagnostics?: any[];
  diagnosticSummary?: string;
  importSuggestions?: string;
  resolvedDefinitions?: string;
  projectRelationships?: string;
  symbolUsages?: string;
  fileHistory?: string;
  /** Multi-line replace fix (syntax/type errors), not cursor insert */
  activeFixTarget?: DiagnosticFixTarget;
  completionMode?: 'insert' | 'replace';
}

/**
 * A broken code region to replace in one Tab (multi-line jump fix).
 */
export interface DiagnosticFixTarget {
  range: vscode.Range;
  brokenText: string;
  messages: string[];
  severity: vscode.DiagnosticSeverity;
  priority: number;
}

/**
 * Represents a single edit event in the editor.
 */
export interface EditEvent {
  file: string;
  timestamp: number;
  range: vscode.Range;
  newText: string;
  oldText: string;
}

/**
 * Detected project-wide coding style and patterns.
 */
export interface ProjectStyle {
  indentation: 'tabs' | 'spaces';
  indentSize: number;
  semicolons: boolean;
  quoteStyle: 'single' | 'double';
  trailingComma: boolean;
  maxLineLength: number;
  namingConventions: {
    variables: 'camelCase' | 'snake_case' | 'PascalCase';
    functions: 'camelCase' | 'snake_case' | 'PascalCase';
    classes: 'PascalCase' | 'camelCase';
    constants: 'UPPER_SNAKE' | 'camelCase';
    files: 'kebab-case' | 'camelCase' | 'PascalCase' | 'snake_case';
  };
  patterns: PatternSignature[];
}

/**
 * A recurring code pattern signature.
 */
export interface PatternSignature {
  name: string;
  frequency: number;
  example: string;
  context: string;
}

/**
 * The result of a single code completion request.
 */
export interface CompletionResult {
  id: string;
  text: string;
  insertText: string;
  range: vscode.Range;
  confidence: number;
  source: 'inline' | 'block' | 'streaming';
  metadata: {
    modelLatencyMs?: number;
    contextTokens?: number;
    completionTokens?: number;
    cached: boolean;
    crossFile?: boolean;
    mode?: 'insert' | 'replace' | 'quickfix';
  };
}

/**
 * Parameters for a model inference request.
 */
export interface ModelRequest {
  prompt: string;
  systemPrompt?: string;
  maxTokens: number;
  temperature: number;
  stopSequences?: string[];
  stream: boolean;
}

/**
 * The response from a model inference request.
 */
export interface ModelResponse {
  text: string;
  finishReason: 'stop' | 'length' | 'error';
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  latencyMs: number;
}

/**
 * A single chunk of a streaming model response.
 */
export interface StreamChunk {
  text: string;
  done: boolean;
}

/**
 * Callback for processing streaming response chunks.
 */
export type StreamCallback = (chunk: StreamChunk) => void;

/**
 * A generic cache entry.
 */
export interface CacheEntry<T> {
  key: string;
  value: T;
  createdAt: number;
  expiresAt: number;
  hits: number;
  hash: string;
}

/**
 * Statistics for cache performance tracking.
 */
export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  hitRate: number;
}

/**
 * Aggregated performance metrics for the extension.
 */
export interface PerformanceMetrics {
  averageLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  totalRequests: number;
  cacheHitRate: number;
  averageContextTokens: number;
  completionsAccepted: number;
  completionsDismissed: number;
  acceptanceRate: number;
}

/**
 * Union type for all possible extension events.
 */
export type AutoCodeEvent =
  | { type: 'completion_triggered'; data: { file: string; position: vscode.Position } }
  | { type: 'completion_shown'; data: { id: string; confidence: number } }
  | { type: 'completion_accepted'; data: { id: string; partial: boolean } }
  | { type: 'completion_dismissed'; data: { id: string; reason: string; text?: string; file?: string; line?: number } }
  | { type: 'context_rebuilt'; data: { tokenCount: number; latencyMs: number } }
  | { type: 'cache_hit'; data: { key: string; level?: number; crossFile?: boolean } }
  | { type: 'file_modified'; data: { uri: string; content?: string } }
  | { type: 'file_saved'; data: { uri: string } }
  | { type: 'cursor_idle'; data: { file: string; position: vscode.Position; durationMs: number } }
  | { type: 'proactive_suggestion'; data: { trigger: string; file: string } }
  | { type: 'cross_file_context_loaded'; data: { files: string[]; totalTokens: number } }
  | { type: 'error'; data: { message: string; stack?: string } };

/**
 * Handler function for extension events.
 */
export type AutoCodeEventHandler = (event: AutoCodeEvent) => void;
