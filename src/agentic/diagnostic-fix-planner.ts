/**
 * Plans multi-line Tab replacements from diagnostics (syntax/type errors).
 */

import * as vscode from 'vscode';
import { ConfigManager } from '../core/config';
import { DiagnosticFixTarget } from '../core/types';

export type { DiagnosticFixTarget };

export class DiagnosticFixPlanner {
  private static instance: DiagnosticFixPlanner;

  static getInstance(): DiagnosticFixPlanner {
    if (!DiagnosticFixPlanner.instance) {
      DiagnosticFixPlanner.instance = new DiagnosticFixPlanner();
    }
    return DiagnosticFixPlanner.instance;
  }

  /**
   * Best fix target near cursor: replaces a multi-line broken region, not a single insert.
   */
  findTarget(
    document: vscode.TextDocument,
    position: vscode.Position
  ): DiagnosticFixTarget | null {
    const diags = vscode.languages
      .getDiagnostics(document.uri)
      .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning);

    if (diags.length === 0) {
      return null;
    }

    const ranked = diags
      .map((d) => {
        const expanded = this.expandToLogicalBlock(document, d.range);
        const dist = this.distanceToRange(position, expanded);
        const priority =
          d.severity * 1000 +
          dist +
          (position.line >= expanded.start.line && position.line <= expanded.end.line
            ? -500
            : 0);
        return { diag: d, expanded, dist, priority };
      })
      .filter((x) => x.dist <= 8)
      .sort((a, b) => a.priority - b.priority);

    const best = ranked[0];
    if (!best) {
      return null;
    }

    const brokenText = document.getText(best.expanded);
    if (!brokenText.trim()) {
      return null;
    }

    return {
      range: best.expanded,
      brokenText,
      messages: [best.diag.message],
      severity: best.diag.severity,
      priority: best.priority,
    };
  }

  /** Cursor on or beside a diagnostic line — use fast Tab trigger. */
  isNearDiagnostic(document: vscode.TextDocument, position: vscode.Position): boolean {
    return vscode.languages.getDiagnostics(document.uri).some((d) => {
      if (d.severity > vscode.DiagnosticSeverity.Warning) {
        return false;
      }
      const line = d.range.start.line;
      return Math.abs(position.line - line) <= 2;
    });
  }

  /** Positions to prefetch fixes (error lines). */
  getPrefetchPositions(document: vscode.TextDocument): vscode.Position[] {
    const lines = new Set<number>();
    for (const d of vscode.languages.getDiagnostics(document.uri)) {
      if (d.severity <= vscode.DiagnosticSeverity.Warning) {
        lines.add(d.range.start.line);
      }
    }
    return [...lines]
      .slice(0, 5)
      .map((line) => new vscode.Position(line, document.lineAt(line).text.length));
  }

  private distanceToRange(position: vscode.Position, range: vscode.Range): number {
    if (position.line < range.start.line) {
      return range.start.line - position.line;
    }
    if (position.line > range.end.line) {
      return position.line - range.end.line;
    }
    return 0;
  }

  /**
   * Grow diagnostic span to full statement / block (multi-line jump fixes).
   */
  expandToLogicalBlock(
    document: vscode.TextDocument,
    diagRange: vscode.Range
  ): vscode.Range {
    const config = ConfigManager.getInstance();
    const maxLines = Math.max(8, config.getValue('maxCompletionLines') || 24);

    let startLine = diagRange.start.line;
    let endLine = diagRange.end.line;

    const growUp = (): void => {
      while (startLine > 0 && endLine - startLine < maxLines) {
        const prev = document.lineAt(startLine - 1).text;
        const cur = document.lineAt(startLine).text;
        if (prev.trim() === '') {
          break;
        }
        if (this.shouldIncludeLine(prev, cur, 'up')) {
          startLine--;
        } else {
          break;
        }
      }
    };

    const growDown = (): void => {
      while (endLine < document.lineCount - 1 && endLine - startLine < maxLines) {
        const next = document.lineAt(endLine + 1).text;
        const cur = document.lineAt(endLine).text;
        if (next.trim() === '') {
          const balance = this.bracketBalance(document, startLine, endLine);
          if (balance <= 0) {
            break;
          }
        }
        if (this.shouldIncludeLine(cur, next, 'down')) {
          endLine++;
        } else {
          break;
        }
      }
    };

    growUp();
    growDown();

    while (
      endLine - startLine < maxLines &&
      this.bracketBalance(document, startLine, endLine) > 0 &&
      endLine < document.lineCount - 1
    ) {
      endLine++;
    }

    const endChar =
      endLine === document.lineCount - 1
        ? document.lineAt(endLine).text.length
        : document.lineAt(endLine).text.length;

    return new vscode.Range(startLine, 0, endLine, endChar);
  }

  private shouldIncludeLine(
    boundary: string,
    inner: string,
    dir: 'up' | 'down'
  ): boolean {
    const b = boundary.trim();
    const i = inner.trim();
    if (!b || !i) {
      return false;
    }
    if (/[{([,=>]$/.test(b) || /^(else|catch|finally|elif|except)\b/.test(i)) {
      return true;
    }
    if (dir === 'up' && /^\s*[})]\]/.test(i)) {
      return true;
    }
    const bIndent = boundary.match(/^(\s*)/)?.[1].length ?? 0;
    const iIndent = inner.match(/^(\s*)/)?.[1].length ?? 0;
    return iIndent <= bIndent && /[{;]$/.test(b);
  }

  private bracketBalance(
    document: vscode.TextDocument,
    startLine: number,
    endLine: number
  ): number {
    let text = '';
    for (let i = startLine; i <= endLine; i++) {
      text += document.lineAt(i).text + '\n';
    }
    let n = 0;
    for (const c of text) {
      if (c === '{' || c === '(' || c === '[') {
        n++;
      } else if (c === '}' || c === ')' || c === ']') {
        n--;
      }
    }
    return n;
  }
}
