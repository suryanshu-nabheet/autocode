/**
 * AutoCode Diagnostic Analyzer Tool
 * 
 * Aggregates and transforms VS Code diagnostics (errors, warnings, lints)
 * into a semantic format that the AI can use to provide fixes during completion.
 */

import * as vscode from 'vscode';
import { Logger } from '../core/logger';

export interface DiagnosticSummary {
  message: string;
  severity: string;
  line: number;
  source?: string;
  code?: string | number | { value: string | number; target: vscode.Uri };
  relatedInformation?: string[];
  snippet?: string;
  fixes?: string[];
}

export class DiagnosticAnalyzer {
  private static instance: DiagnosticAnalyzer;
  private logger = Logger.getInstance();

  private constructor() {}

  public static getInstance(): DiagnosticAnalyzer {
    if (!DiagnosticAnalyzer.instance) {
      DiagnosticAnalyzer.instance = new DiagnosticAnalyzer();
    }
    return DiagnosticAnalyzer.instance;
  }

  /**
   * Errors/warnings across the current file and related workspace files (agentic fix context).
   */
  public analyzeProjectDiagnostics(
    document: vscode.TextDocument,
    position: vscode.Position,
    relatedRelativePaths: string[] = []
  ): DiagnosticSummary[] {
    const seen = new Set<string>();
    const merged: DiagnosticSummary[] = [];

    const addFromDoc = (doc: vscode.TextDocument, relPath: string) => {
      if (seen.has(relPath)) return;
      seen.add(relPath);
      const diags = vscode.languages.getDiagnostics(doc.uri);
      for (const d of diags) {
        if (d.severity > vscode.DiagnosticSeverity.Warning) {
          continue;
        }
        const summary: DiagnosticSummary = {
          message: d.message,
          severity: this.getSeverityName(d.severity),
          line: d.range.start.line + 1,
          source: d.source,
          code: d.code,
        };
        try {
          summary.snippet = doc.lineAt(d.range.start.line).text.trim();
        } catch {
          // ignore
        }
        if (d.relatedInformation?.length) {
          summary.relatedInformation = d.relatedInformation.map(
            (ri) =>
              `[${vscode.workspace.asRelativePath(ri.location.uri)}:L${ri.location.range.start.line + 1}] ${ri.message}`
          );
        }
        merged.push({ ...summary, message: `[${relPath}] ${summary.message}` });
      }
    };

    addFromDoc(document, vscode.workspace.asRelativePath(document.uri));

    const relatedSet = new Set(relatedRelativePaths.map((p) => p.replace(/\\/g, '/')));
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.isClosed || doc.uri.scheme !== 'file') continue;
      const rel = vscode.workspace.asRelativePath(doc.uri);
      if (rel === vscode.workspace.asRelativePath(document.uri)) continue;
      if (relatedSet.has(rel) || doc.languageId === document.languageId) {
        addFromDoc(doc, rel);
      }
    }

    return merged
      .sort((a, b) => {
        const sev = (s: string) => (s === 'ERROR' ? 0 : 1);
        if (sev(a.severity) !== sev(b.severity)) return sev(a.severity) - sev(b.severity);
        return Math.abs(a.line - (position.line + 1)) - Math.abs(b.line - (position.line + 1));
      })
      .slice(0, 20);
  }

  /**
   * Get a summarized list of diagnostics for the current file and its surroundings.
   */
  public analyzeDiagnostics(document: vscode.TextDocument, position: vscode.Position): DiagnosticSummary[] {
    const diagnostics = vscode.languages.getDiagnostics(document.uri);
    
    // Sort by severity (errors first) and proximity to cursor
    const sorted = diagnostics.sort((a, b) => {
      if (a.severity !== b.severity) {
        return a.severity - b.severity; // Lower number is higher severity
      }
      return Math.abs(a.range.start.line - position.line) - Math.abs(b.range.start.line - position.line);
    });

    return sorted.map(d => {
      const summary: DiagnosticSummary = {
        message: d.message,
        severity: this.getSeverityName(d.severity),
        line: d.range.start.line + 1,
        source: d.source,
        code: d.code,
      };

      // Add related information if available
      if (d.relatedInformation && d.relatedInformation.length > 0) {
        summary.relatedInformation = d.relatedInformation.map(ri => 
          `[${ri.location.uri.fsPath.split('/').pop()}:L${ri.location.range.start.line + 1}] ${ri.message}`
        );
      }

      // Add a snippet of the problematic line
      try {
        const lineText = document.lineAt(d.range.start.line).text;
        summary.snippet = lineText.trim();
      } catch {
        // Line might be out of bounds if doc changed
      }

      return summary;
    });
  }

  /**
   * Format diagnostics for inclusion in the AI prompt.
   */
  public formatForPrompt(summaries: DiagnosticSummary[]): string {
    if (summaries.length === 0) return '';

    const lines = summaries.map(s => {
      let line = `[${s.severity}] L${s.line}: ${s.message}`;
      if (s.snippet) line += ` (Code: "${s.snippet}")`;
      if (s.relatedInformation) {
        line += `\n    Related: ${s.relatedInformation.join(', ')}`;
      }
      return line;
    });

    return `<diagnostics>\n${lines.join('\n')}\n</diagnostics>`;
  }

  public formatProjectForPrompt(summaries: DiagnosticSummary[]): string {
    if (summaries.length === 0) return '';
    const lines = summaries.map((s) => {
      let line = `[${s.severity}] ${s.message} (L${s.line})`;
      if (s.snippet) line += ` — "${s.snippet}"`;
      if (s.relatedInformation?.length) {
        line += `\n    → ${s.relatedInformation.join('; ')}`;
      }
      return line;
    });
    return `<project_diagnostics>\nFix these across files when completing:\n${lines.join('\n')}\n</project_diagnostics>`;
  }

  private getSeverityName(severity: vscode.DiagnosticSeverity): string {
    switch (severity) {
      case vscode.DiagnosticSeverity.Error: return 'ERROR';
      case vscode.DiagnosticSeverity.Warning: return 'WARNING';
      case vscode.DiagnosticSeverity.Information: return 'INFO';
      case vscode.DiagnosticSeverity.Hint: return 'HINT';
      default: return 'ISSUE';
    }
  }
}
