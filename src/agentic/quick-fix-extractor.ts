/**
 * Instant multi-line fixes from VS Code Quick Fix code actions (no LLM).
 */

import * as vscode from 'vscode';
import { CompletionResult } from '../core/types';
import { DiagnosticFixTarget } from '../core/types';

export async function tryExtractQuickFix(
  document: vscode.TextDocument,
  target: DiagnosticFixTarget
): Promise<CompletionResult | null> {
  let actions: vscode.CodeAction[] | undefined;
  try {
    actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      'vscode.executeCodeActionProvider',
      document.uri,
      target.range,
      vscode.CodeActionKind.QuickFix.value,
      10
    );
  } catch {
    return null;
  }

  if (!actions?.length) {
    return null;
  }

  for (const action of actions) {
    if (!action.edit) {
      continue;
    }
    const edits = action.edit.get(document.uri);
    if (!edits?.length) {
      continue;
    }

    const primary =
      edits.find((e) => target.range.intersection(e.range)) ?? edits[0];
    const newText = mergeEditsIntoRange(document, target.range, edits);
    if (newText && newText.trim() && newText !== target.brokenText) {
      return {
        id: `qf-${Date.now()}`,
        text: newText,
        insertText: newText,
        range: target.range,
        confidence: 0.99,
        source: 'block',
        metadata: { cached: false, mode: 'quickfix' },
      };
    }

    if (primary.newText.trim() && primary.newText !== target.brokenText) {
      const range = primary.range.union(target.range);
      return {
        id: `qf-${Date.now()}`,
        text: primary.newText,
        insertText: primary.newText,
        range,
        confidence: 0.99,
        source: 'block',
        metadata: { cached: false, mode: 'quickfix' },
      };
    }
  }

  return null;
}

/** Apply all text edits and return the resulting text for `range`. */
function mergeEditsIntoRange(
  document: vscode.TextDocument,
  range: vscode.Range,
  edits: vscode.TextEdit[]
): string | null {
  let full = document.getText();
  const sorted = [...edits].sort(
    (a, b) => b.range.start.compareTo(a.range.start)
  );

  for (const e of sorted) {
    const start = document.offsetAt(e.range.start);
    const end = document.offsetAt(e.range.end);
    if (start < 0 || end > full.length) {
      continue;
    }
    full = full.substring(0, start) + e.newText + full.substring(end);
  }

  const start = document.offsetAt(range.start);
  const end = document.offsetAt(range.end);
  if (start >= full.length) {
    return null;
  }
  return full.substring(start, Math.min(end, full.length));
}
