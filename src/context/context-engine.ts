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
import { withTimeout } from '../utils/timeout';
import { DiagnosticFixPlanner } from '../agentic/diagnostic-fix-planner';

// Agentic Tools
import { DiagnosticAnalyzer } from '../tools/diagnostic-analyzer';
import { ImportTool } from '../tools/import-tool';
import { DefinitionTool } from '../tools/definition-tool';
import { HistoryTool } from '../tools/history-tool';
import { ProjectGraphTool } from '../tools/project-graph-tool';
import { SymbolUsageTool } from '../tools/symbol-usage-tool';

const CURSOR_WINDOW_LINES = 40;
const MAX_RELATED_FILES = 5;
const MAX_SYMBOLS = 60;
const SIGNATURE_TIMEOUT_MS = 180;
const RELATED_FILES_TIMEOUT_MS = 120;

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
    const fixTarget = DiagnosticFixPlanner.getInstance().findTarget(document, position);
    const completionMode = fixTarget ? 'replace' as const : 'insert' as const;

    // 1. ULTRA-FAST PATH: Same line, small movement
    if (this.lastPosition && this.lastContext) {
        const parts = this.lastPosition.split('#');
        const lastLine = parseInt(parts[parts.length - 2] || '-1');
        const lastChar = parseInt(parts[parts.length - 1] || '-1');
        if (lastLine === position.line && Math.abs(position.character - lastChar) < 3) {
            return { ...this.lastContext, currentFile: cursorContext };
        }
    }

    // 2. CRITICAL PATH (bounded latency)
    const isStale = this.lastVersion !== document.version;
    const imports = isStale ? this.importAnalyzer.analyzeImports(document) : this.cachedImports;
    const relatedPaths = imports
      .map((imp) => (imp.resolvedPath ? vscode.workspace.asRelativePath(vscode.Uri.file(imp.resolvedPath)) : ''))
      .filter(Boolean);
    const diagAnalys = this.diagnosticAnalyzer.analyzeDiagnostics(document, position);
    const projectDiags = this.diagnosticAnalyzer.analyzeProjectDiagnostics(
      document,
      position,
      relatedPaths
    );

    const [symbols, resolvedSignatures] = await Promise.all([
      isStale
        ? withTimeout(
            this.symbolAnalyzer.getSymbols(document, token, MAX_SYMBOLS),
            120,
            this.cachedSymbols
          )
        : Promise.resolve(this.cachedSymbols),
      withTimeout(
        this.semanticResolver.resolveImportSignatures(document, imports, token),
        SIGNATURE_TIMEOUT_MS,
        (this.backgroundContext.resolvedSignatures as string[]) || []
      ),
    ]);

    if (isStale || diagAnalys.length > 0) {
      this.cachedSymbols = symbols;
      this.cachedImports = imports;
      this.lastVersion = document.version;
      this.refreshBackgroundContext(document, position, imports, symbols, diagAnalys.length > 0);
    }

    // 3. ASSEMBLE (warm background + cached style)
    const projectStyle = this.config.getValue('styleLearnEnabled')
      ? await withTimeout(
          this.styleAnalyzer.analyzeStyle(document),
          80,
          this.styleAnalyzer.getDefaultStyle()
        )
      : this.styleAnalyzer.getDefaultStyle();
    
    const context: ProjectContext = {
      currentFile: cursorContext,
      completionMode,
      activeFixTarget: fixTarget ?? undefined,
      openFiles: (this.backgroundContext.openFiles || []) as FileContext[],
      relatedFiles: (this.backgroundContext.relatedFiles || []) as FileContext[],
      symbols,
      imports,
      gitDiffs: (this.backgroundContext.gitDiffs || []) as GitDiff[],
      recentEdits: this.getRecentEdits(),
      projectStyle,
      resolvedSignatures:
        resolvedSignatures.length > 0
          ? resolvedSignatures
          : ((this.backgroundContext.resolvedSignatures || []) as string[]),
      diagnostics: vscode.languages.getDiagnostics(document.uri),
      diagnosticSummary: [
        this.diagnosticAnalyzer.formatForPrompt(diagAnalys),
        this.diagnosticAnalyzer.formatProjectForPrompt(projectDiags),
      ]
        .filter(Boolean)
        .join('\n\n'),
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

  /** Warm agentic context without blocking the inline-completion critical path. */
  public warmBackgroundContext(document: vscode.TextDocument, position: vscode.Position): void {
    const imports = this.importAnalyzer.analyzeImports(document);
    const symbols = this.cachedSymbols.length > 0 ? this.cachedSymbols : [];
    this.refreshBackgroundContext(document, position, imports, symbols, false);
  }

  private async refreshBackgroundContext(
    document: vscode.TextDocument,
    position: vscode.Position,
    imports: ImportInfo[],
    symbols: SymbolInfo[],
    prioritizeErrors: boolean = false
  ) {
    if (this.isBackgroundUpdating && !prioritizeErrors) return;
    this.isBackgroundUpdating = true;

    try {
      const safe = <T>(label: string, fallback: T) => (err: unknown): T => {
        this.logger.debug(`Background ${label} failed`, err);
        return fallback;
      };

      const [
        openFiles,
        relatedFiles,
        importAnalys,
        definitions,
        usages,
        projectRel,
      ] = await Promise.all([
        this.getOpenFileContexts(document.uri).catch(safe('openFiles', [])),
        withTimeout(
          this.findRelatedFiles(document, imports, symbols),
          RELATED_FILES_TIMEOUT_MS,
          (this.backgroundContext.relatedFiles as FileContext[]) || []
        ),
        this.importTool.getImportPrompt(document).catch(safe('importPrompt', '')),
        withTimeout(
          this.definitionTool.resolveDefinition(document, position).catch(safe('definitions', null)),
          200,
          null
        ),
        withTimeout(
          this.symbolUsageTool.findUsages(document, position).catch(safe('symbolUsages', [])),
          200,
          [] as any[]
        ),
        this.projectGraphTool.findRelatedFiles(document).catch(safe('projectGraph', [])),
      ]);

      const bgSignatures = await withTimeout(
        this.semanticResolver.resolveImportSignatures(
          document,
          imports,
          new vscode.CancellationTokenSource().token
        ),
        SIGNATURE_TIMEOUT_MS,
        (this.backgroundContext.resolvedSignatures as string[]) || []
      );

      this.backgroundContext = {
        openFiles: openFiles as FileContext[],
        relatedFiles: relatedFiles as FileContext[],
        gitDiffs: (this.backgroundContext.gitDiffs || []) as GitDiff[],
        importSuggestions: importAnalys as string,
        fileHistory: (this.backgroundContext.fileHistory || '') as string,
        projectRelationships: this.projectGraphTool.formatForPrompt(projectRel as any),
        resolvedDefinitions: definitions ? this.definitionTool.formatForPrompt([definitions]) : '',
        symbolUsages: (usages as any[]).length > 0 ? this.symbolUsageTool.formatForPrompt(usages as any) : '',
        resolvedSignatures: bgSignatures,
      };

      void Promise.all([
        this.gitAnalyzer.getRecentDiffs().then((gitDiffs) => {
          this.backgroundContext.gitDiffs = gitDiffs;
        }),
        this.historyTool.getFileHistory(document.uri.fsPath).then((fileHistory) => {
          this.backgroundContext.fileHistory = this.historyTool.formatForPrompt(fileHistory as any);
        }),
      ]).catch(() => undefined);

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
