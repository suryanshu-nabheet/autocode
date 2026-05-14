/**
 * AutoCode Context Engine
 * 
 * The brain of the system. Builds deep, ranked context from:
 * - Current cursor position and file content
 * - Open editor tabs
 * - Related files via imports / symbol graph
 * - Git diffs and recent edits
 * - Agentic tools (Diagnostics, Imports, Definitions, History, Graph, Usage)
 */

import * as vscode from 'vscode';
import {
  ProjectContext,
  CursorContext,
  FileContext,
  SymbolInfo,
  ImportInfo,
  EditEvent,
  GitDiff,
} from '../core/types';
import { ConfigManager } from '../core/config';
import { Logger } from '../core/logger';
import { EventBus } from '../core/event-bus';
import { SymbolAnalyzer } from './analyzers/symbol-analyzer';
import { ImportAnalyzer } from './analyzers/import-analyzer';
import { GitAnalyzer } from './analyzers/git-analyzer';
import { StyleAnalyzer } from '../style-learning/style-analyzer';
import { SemanticResolver } from './semantic-resolver';
import { ContextRanker } from './context-ranker';

// Agentic Tools
import { DiagnosticAnalyzer } from '../tools/diagnostic-analyzer';
import { ImportTool } from '../tools/import-tool';
import { DefinitionTool } from '../tools/definition-tool';
import { HistoryTool } from '../tools/history-tool';
import { ProjectGraphTool } from '../tools/project-graph-tool';
import { SymbolUsageTool } from '../tools/symbol-usage-tool';

const CURSOR_WINDOW_LINES = 60;
const MAX_RELATED_FILES = 8;
const MAX_SYMBOLS = 100;

export class ContextEngine implements vscode.Disposable {
  private config: ConfigManager;
  private logger: Logger;
  private eventBus: EventBus;
  private symbolAnalyzer: SymbolAnalyzer;
  private importAnalyzer: ImportAnalyzer;
  private gitAnalyzer: GitAnalyzer;
  private styleAnalyzer: StyleAnalyzer;
  private semanticResolver: SemanticResolver;
  private contextRanker: ContextRanker;
  
  private diagnosticAnalyzer: DiagnosticAnalyzer;
  private importTool: ImportTool;
  private definitionTool: DefinitionTool;
  private historyTool: HistoryTool;
  private projectGraphTool: ProjectGraphTool;
  private symbolUsageTool: SymbolUsageTool;

  private editHistory: EditEvent[] = [];
  private disposables: vscode.Disposable[] = [];
  private readonly MAX_EDIT_HISTORY = 100;
  
  private lastContext: ProjectContext | null = null;
  private lastPosition: string = '';

  constructor() {
    this.config = ConfigManager.getInstance();
    this.logger = Logger.getInstance();
    this.eventBus = EventBus.getInstance();
    this.symbolAnalyzer = new SymbolAnalyzer();
    this.importAnalyzer = new ImportAnalyzer();
    this.gitAnalyzer = new GitAnalyzer();
    this.styleAnalyzer = new StyleAnalyzer();
    this.semanticResolver = new SemanticResolver();
    this.contextRanker = new ContextRanker();
    
    this.diagnosticAnalyzer = DiagnosticAnalyzer.getInstance();
    this.importTool = ImportTool.getInstance();
    this.definitionTool = DefinitionTool.getInstance();
    this.historyTool = HistoryTool.getInstance();
    this.projectGraphTool = ProjectGraphTool.getInstance();
    this.symbolUsageTool = SymbolUsageTool.getInstance();

    this.setupEditTracking();
  }

  private lastVersion: number = -1;
  private cachedSymbols: SymbolInfo[] = [];
  private cachedImports: ImportInfo[] = [];

  /**
   * Build the full project context for a given position.
   */
  private backgroundContext: Partial<ProjectContext> = {};
  private isBackgroundUpdating = false;

  /**
   * Build the project context. Returns critical data instantly,
   * using warm background data for the rest.
   */
  async buildContext(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<ProjectContext> {
    const cursorContext = this.buildCursorContext(document, position);
    
    // 1. ULTRA-FAST PATH: Same line, small movement
    if (this.lastPosition && this.lastContext) {
        const parts = this.lastPosition.split('#');
        const lastLine = parseInt(parts[parts.length - 2] || '-1');
        const lastChar = parseInt(parts[parts.length - 1] || '-1');
        if (lastLine === position.line && Math.abs(position.character - lastChar) < 3) {
            return { ...this.lastContext, currentFile: cursorContext };
        }
    }

    // 2. CRITICAL PATH (Must be fast)
    const isStale = this.lastVersion !== document.version;
    const symbols = isStale ? await this.symbolAnalyzer.getSymbols(document, token, MAX_SYMBOLS) : this.cachedSymbols;
    const imports = isStale ? this.importAnalyzer.analyzeImports(document) : this.cachedImports;
    const diagAnalys = await this.diagnosticAnalyzer.analyzeDiagnostics(document, position);

    if (isStale || diagAnalys.length > 0) {
      this.cachedSymbols = symbols;
      this.cachedImports = imports;
      this.lastVersion = document.version;
      // Trigger background refresh on document change or error detection
      this.refreshBackgroundContext(document, position, diagAnalys.length > 0);
    }

    // 3. ASSEMBLE (Using warm background data)
    const projectStyle = await this.styleAnalyzer.analyzeStyle(document);
    
    const context: ProjectContext = {
      currentFile: cursorContext,
      openFiles: (this.backgroundContext.openFiles || []) as FileContext[],
      relatedFiles: (this.backgroundContext.relatedFiles || []) as FileContext[],
      symbols,
      imports,
      gitDiffs: (this.backgroundContext.gitDiffs || []) as GitDiff[],
      recentEdits: this.getRecentEdits(),
      projectStyle,
      resolvedSignatures: (this.backgroundContext.resolvedSignatures || []) as string[],
      diagnostics: vscode.languages.getDiagnostics(document.uri),
      diagnosticSummary: this.diagnosticAnalyzer.formatForPrompt(diagAnalys),
      importSuggestions: (this.backgroundContext.importSuggestions || '') as string,
      resolvedDefinitions: (this.backgroundContext.resolvedDefinitions || '') as string,
      projectRelationships: (this.backgroundContext.projectRelationships || '') as string,
      symbolUsages: (this.backgroundContext.symbolUsages || '') as string,
      fileHistory: (this.backgroundContext.fileHistory || '') as string
    };

    const compressed = this.contextRanker.rankAndCompress(context, this.config.getValue('maxContextTokens'));
    this.lastContext = compressed;
    this.lastPosition = `${document.uri.toString()}#${position.line}#${position.character}`;

    return compressed;
  }

  private async refreshBackgroundContext(document: vscode.TextDocument, position: vscode.Position, prioritizeErrors: boolean = false) {
    if (this.isBackgroundUpdating && !prioritizeErrors) return;
    this.isBackgroundUpdating = true;

    try {
      const safe = <T>(label: string, fallback: T) => (err: unknown): T => {
        this.logger.debug(`Background ${label} failed`, err);
        return fallback;
      };

      const [
        openFiles,
        gitDiffs,
        importAnalys,
        fileHistory,
        projectRel,
        definitions,
        usages
      ] = await Promise.all([
        this.getOpenFileContexts(document.uri).catch(safe('openFiles', [])),
        this.gitAnalyzer.getRecentDiffs().catch(safe('gitDiffs', [])),
        this.importTool.getImportPrompt(document).catch(safe('importPrompt', '')),
        this.historyTool.getFileHistory(document.uri.fsPath).catch(safe('fileHistory', [])),
        this.projectGraphTool.findRelatedFiles(document).catch(safe('projectGraph', [])),
        this.definitionTool.resolveDefinition(document, position).catch(safe('definitions', null)),
        this.symbolUsageTool.findUsages(document, position).catch(safe('symbolUsages', []))
      ]);

      this.backgroundContext = {
        openFiles: openFiles as FileContext[],
        gitDiffs: gitDiffs as GitDiff[],
        importSuggestions: importAnalys as string,
        fileHistory: this.historyTool.formatForPrompt(fileHistory as any),
        projectRelationships: this.projectGraphTool.formatForPrompt(projectRel as any),
        resolvedDefinitions: definitions ? this.definitionTool.formatForPrompt([definitions]) : '',
        symbolUsages: usages.length > 0 ? this.symbolUsageTool.formatForPrompt(usages) : '',
        // If prioritizeErrors is true, we could add even more specific lookups here
      };

      if (prioritizeErrors) {
          this.logger.debug('Prioritizing error correction context');
      }
    } finally {
      this.isBackgroundUpdating = false;
    }
  }

  private buildCursorContext(
    document: vscode.TextDocument,
    position: vscode.Position
  ): CursorContext {
    const line = document.lineAt(position.line);
    const linePrefix = line.text.substring(0, position.character);
    const lineSuffix = line.text.substring(position.character);

    const startLine = Math.max(0, position.line - CURSOR_WINDOW_LINES);
    const endLine = Math.min(
      document.lineCount - 1,
      position.line + CURSOR_WINDOW_LINES
    );

    const precedingRange = new vscode.Range(startLine, 0, position.line, 0);
    const followingRange = new vscode.Range(
      position.line + 1,
      0,
      endLine,
      document.lineAt(endLine).text.length
    );

    const precedingLines = document.getText(precedingRange);
    const followingLines =
      position.line < document.lineCount - 1
        ? document.getText(followingRange)
        : '';

    const indentMatch = line.text.match(/^(\s*)/);
    const indentation = indentMatch ? indentMatch[1] : '';

    const editor = vscode.window.activeTextEditor;
    const selectedText =
      editor && !editor.selection.isEmpty
        ? document.getText(editor.selection)
        : undefined;

    const fileContext = this.buildFileContext(document);

    return {
      file: fileContext,
      position,
      linePrefix,
      lineSuffix,
      precedingLines,
      followingLines,
      selectedText,
      indentation,
    };
  }

  private buildFileContext(document: vscode.TextDocument): FileContext {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const relativePath = workspaceFolder
      ? vscode.workspace.asRelativePath(document.uri)
      : document.fileName;

    return {
      uri: document.uri,
      relativePath,
      languageId: document.languageId,
      content: document.getText(),
      version: document.version,
      lineCount: document.lineCount,
      diagnostics: vscode.languages.getDiagnostics(document.uri),
    };
  }

  private openFileCache = new Map<string, { context: FileContext; version: number }>();

  private async getOpenFileContexts(
    currentUri: vscode.Uri
  ): Promise<FileContext[]> {
    const openFiles: FileContext[] = [];

    for (const tabGroup of vscode.window.tabGroups.all) {
      for (const tab of tabGroup.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          const uri = tab.input.uri;
          if (uri.toString() === currentUri.toString()) {continue;}

          try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const cacheKey = uri.toString();
            const cached = this.openFileCache.get(cacheKey);

            if (cached && cached.version === doc.version) {
              openFiles.push(cached.context);
            } else {
              const context = this.buildFileContext(doc);
              this.openFileCache.set(cacheKey, { context, version: doc.version });
              openFiles.push(context);
            }
          } catch {
            // File might have been deleted or become unavailable
          }
        }
      }
    }

    return openFiles;
  }

  private async findRelatedFiles(
    document: vscode.TextDocument,
    imports: ImportInfo[],
    _symbols: SymbolInfo[]
  ): Promise<FileContext[]> {
    const relatedUris = new Set<string>();
    const relatedFiles: FileContext[] = [];

    for (const imp of imports) {
      if (imp.resolvedPath) {
        relatedUris.add(imp.resolvedPath);
      }
    }

    const currentRelPath = vscode.workspace.asRelativePath(document.uri);
    const reverseImports = await this.importAnalyzer.findReverseImports(
      currentRelPath
    );
    for (const uri of reverseImports) {
      relatedUris.add(uri);
    }

    let count = 0;
    for (const uriStr of relatedUris) {
      if (count >= MAX_RELATED_FILES) {break;}
      try {
        const uri = vscode.Uri.file(uriStr);
        const doc = await vscode.workspace.openTextDocument(uri);
        relatedFiles.push(this.buildFileContext(doc));
        count++;
      } catch {
        // File not found, skip
      }
    }

    return relatedFiles;
  }

  private setupEditTracking(): void {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        for (const change of e.contentChanges) {
          const edit: EditEvent = {
            file: vscode.workspace.asRelativePath(e.document.uri),
            timestamp: Date.now(),
            range: change.range,
            newText: change.text,
            oldText: '',
          };
          this.editHistory.push(edit);
          if (this.editHistory.length > this.MAX_EDIT_HISTORY) {
            this.editHistory.shift();
          }
        }
      })
    );
  }

  private getRecentEdits(): EditEvent[] {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    return this.editHistory.filter((e) => e.timestamp > fiveMinutesAgo);
  }

  private async buildFallbackContext(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<ProjectContext> {
    return {
      currentFile: this.buildCursorContext(document, position),
      openFiles: [],
      relatedFiles: [],
      symbols: [],
      imports: [],
      gitDiffs: [],
      recentEdits: [],
      projectStyle: this.styleAnalyzer.getDefaultStyle(),
    };
  }

  clearCache(): void {
    this.cachedSymbols = [];
    this.cachedImports = [];
    this.lastVersion = -1;
    this.lastContext = null;
    this.lastPosition = '';
    this.backgroundContext = {};
    this.editHistory = [];
    this.openFileCache.clear();
    this.symbolAnalyzer.clearCache();
    this.importAnalyzer.clearCache();
    this.styleAnalyzer.invalidate();
    this.logger.info('Context engine cache cleared');
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
