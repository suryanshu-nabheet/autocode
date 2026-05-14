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
