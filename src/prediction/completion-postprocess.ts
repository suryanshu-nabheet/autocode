/**
 * Post-process model output into multi-line insertable code.
 */

import { ConfigManager } from '../core/config';

/** Bracket balance for { } [ ] ( ) — truncate blank lines only when balanced. */
function bracketBalance(text: string): number {
  let n = 0;
  let inStr: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const prev = i > 0 ? text[i - 1] : '';
    if (inStr) {
      if (c === inStr && prev !== '\\') {
        inStr = null;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') {
      n++;
    } else if (c === '}' || c === ')' || c === ']') {
      n--;
    }
  }
  return n;
}

export function postProcessCompletion(raw: string, linePrefix: string): string {
  let processed = raw.replace(/<\|fim_middle\|>|<\|fim_suffix\|>|<\|fim_prefix\|>/g, '');

  if (processed.startsWith(linePrefix)) {
    processed = processed.substring(linePrefix.length);
  } else if (linePrefix.trim()) {
    const trimPrefix = linePrefix.trim();
    const idx = processed.trimStart().indexOf(trimPrefix);
    if (idx === 0) {
      processed = processed.trimStart().substring(trimPrefix.length);
    }
  }

  processed = processed.split('<|')[0];
  processed = processed.replace(/^```[\w]*\n?/, '').replace(/\n?```\s*$/, '');

  const blankIdx = processed.search(/\n\s*\n/);
  if (blankIdx >= 0 && bracketBalance(processed.substring(0, blankIdx)) === 0) {
    processed = processed.substring(0, blankIdx);
  }

  const config = ConfigManager.getInstance();
  const maxLines = Math.max(4, config.getValue('maxCompletionLines') || 24);
  const maxChars = maxLines * 120;

  const lines = processed.split('\n');
  if (lines.length > maxLines) {
    processed = lines.slice(0, maxLines).join('\n');
  }

  processed = processed.trimEnd();
  if (!processed || processed.length > maxChars) {
    return '';
  }

  return processed;
}

/**
 * Model output for multi-line REPLACE (fix broken region).
 */
export function postProcessReplacement(raw: string, brokenText: string): string {
  let processed = raw.replace(/<\|fim_middle\|>|<\|fim_suffix\|>|<\|fim_prefix\|>/g, '');
  processed = processed.split('<|')[0];
  processed = processed.replace(/^```[\w]*\n?/, '').replace(/\n?```\s*$/g, '');

  const brokenTrim = brokenText.trim();
  if (processed.trim() === brokenTrim) {
    return '';
  }

  if (processed.includes(brokenTrim) && processed.length > brokenTrim.length * 1.2) {
    const idx = processed.indexOf(brokenTrim);
    if (idx === 0) {
      processed = processed.substring(brokenTrim.length).trimStart();
    }
  }

  const config = ConfigManager.getInstance();
  const maxLines = Math.max(4, config.getValue('maxCompletionLines') || 24);
  const lines = processed.split('\n');
  if (lines.length > maxLines + 4) {
    processed = lines.slice(0, maxLines + 4).join('\n');
  }

  processed = processed.trimEnd();
  if (!processed || processed.length > maxLines * 150) {
    return '';
  }

  return processed;
}

export function estimateMaxTokens(): number {
  const config = ConfigManager.getInstance();
  const lines = config.getValue('maxCompletionLines') || 24;
  const configured = config.getValue('maxTokens') || 256;
  const fromLines = lines * 56;
  return Math.min(1536, Math.max(configured, fromLines));
}
