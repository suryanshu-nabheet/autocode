/**
 * AutoCode Symbol Analyzer
 * 
 * Extracts symbol information (functions, classes, variables, types)
 * from the current document and workspace using VS Code's built-in
 * document symbol provider and workspace symbol search.
 */

import * as vscode from 'vscode';
import { SymbolInfo } from '../../core/types';
import { Logger } from '../../core/logger';

/**
 * Manages the discovery and caching of code symbols to provide structural context.
 */
export class SymbolAnalyzer {
  private logger = Logger.getInstance();
  private symbolCache = new Map<string, { symbols: SymbolInfo[]; version: number }>();

  /**
   * Get symbols from the current document and related workspace symbols.
   * This is used to build a comprehensive map of the code structure around the cursor.
   * @param document The current text document
   * @param token The cancellation token
   * @param maxSymbols Maximum number of symbols to retrieve
   * @returns A promise that resolves to an array of SymbolInfo objects
   */
  async getSymbols(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
    maxSymbols: number
  ): Promise<SymbolInfo[]> {
    const timer = this.logger.time('SymbolAnalyzer.getSymbols');

    try {
      // Check for valid cache entry
      const cached = this.symbolCache.get(document.uri.toString());
      if (cached && cached.version === document.version) {
        timer();
        return cached.symbols;
      }

      // Phase 1: Local Document Symbols (Fast)
      const docSymbols = await this.getDocumentSymbols(document, token);
      
      if (token.isCancellationRequested) {
        timer();
        return docSymbols;
      }

      // Phase 2: Remote Workspace Symbols (Slower)
      // Only triggered if we haven't reached the token limit yet
      const referencedSymbols = await this.getReferencedSymbols(document, token);

      const allSymbols = [...docSymbols, ...referencedSymbols].slice(0, maxSymbols);

      // Update cache
      this.symbolCache.set(document.uri.toString(), {
        symbols: allSymbols,
        version: document.version,
      });

      timer();
      return allSymbols;
    } catch (err) {
      this.logger.error('Symbol analysis failed', err);
      timer();
      return [];
    }
  }

  /**
   * Get all symbols defined locally in the current document.
   */
  private async getDocumentSymbols(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): Promise<SymbolInfo[]> {
    try {
      const symbols = await vscode.commands.executeCommand<
        vscode.DocumentSymbol[]
      >('vscode.executeDocumentSymbolProvider', document.uri);

      if (!symbols) {return [];}

      return this.flattenSymbols(symbols, document.uri.fsPath);
    } catch (err) {
        this.logger.debug(`Document symbol provider failed for ${document.uri.fsPath}`);
        return [];
    }
  }

  /**
   * Find workspace symbols that are semantically referenced in the current document.
   */
  private async getReferencedSymbols(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): Promise<SymbolInfo[]> {
    const text = document.getText();
    const identifiers = this.extractIdentifiers(text);
    const seen = new Set<string>();

    // Query workspace for unique identifiers (limited to top 20 for performance)
    const topIdentifiers = identifiers.slice(0, 20).filter((id) => {
      if (seen.has(id)) {return false;}
      seen.add(id);
      return true;
    });

    const queries = topIdentifiers.map(async (id) => {
      try {
        const wsSymbols = await vscode.commands.executeCommand<
          vscode.SymbolInformation[]
        >('vscode.executeWorkspaceSymbolProvider', id);

        if (!wsSymbols) {return [];}

        return wsSymbols.slice(0, 3)
          .filter((sym) => sym.location.uri.toString() !== document.uri.toString())
          .map((sym) => ({
            name: sym.name,
            kind: sym.kind,
            range: sym.location.range,
            containerName: sym.containerName,
            filePath: sym.location.uri.fsPath,
          }));
      } catch (err) {
        this.logger.debug(`Workspace symbol lookup failed for "${id}"`, err);
        return [];
      }
    });

    const nested = await Promise.all(queries);
    return nested.flat();
  }

  /**
   * Flattens a nested DocumentSymbol tree into a linear SymbolInfo array.
   */
  private flattenSymbols(
    symbols: vscode.DocumentSymbol[],
    filePath: string,
    containerName?: string
  ): SymbolInfo[] {
    const result: SymbolInfo[] = [];

    for (const sym of symbols) {
      result.push({
        name: sym.name,
        kind: sym.kind,
        range: sym.range,
        containerName,
        detail: sym.detail,
        filePath,
      });

      if (sym.children && sym.children.length > 0) {
        result.push(
          ...this.flattenSymbols(sym.children, filePath, sym.name)
        );
      }
    }

    return result;
  }

  /**
   * Extract potential class and type identifiers from source code.
   */
  private extractIdentifiers(text: string): string[] {
    // Focus on PascalCase identifiers which typically represent classes, types, or modules
    const regex = /\b([A-Z][a-zA-Z0-9]{2,})\b/g;
    const identifiers = new Set<string>();
    let match;

    while ((match = regex.exec(text)) !== null) {
      identifiers.add(match[1]);
    }

    return Array.from(identifiers);
  }

  /** 
   * Invalidate the symbol cache for a specific file.
   */
  invalidate(uri: vscode.Uri): void {
    this.symbolCache.delete(uri.toString());
  }

  /** 
   * Clear the entire cache.
   */
  clearCache(): void {
    this.symbolCache.clear();
  }
}
