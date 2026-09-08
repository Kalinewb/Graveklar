// Client-safe rendering for the short admin-editable notes on the front page.
//
// The terms renderer (`renderTermsString` in terms-template.ts) does the same
// {{token}} substitution, but it lives next to `buildTermsContext`, which
// imports the database. Pulling that into a 'use client' component would drag
// Prisma into the browser bundle, so the substitution lives here instead: no
// imports, no server dependencies.
//
// Two things a note can do:
//   {{token}}   → the value from ctx, or the token left visible if unknown
//   **bold**    → a <strong> run, so an editable string can still emphasise
//                 the phrase the design leans on
//
// Deliberately not Markdown. These are one- or two-sentence notes; a full
// parser would let an admin paste a link or an image into a layout that has no
// room for one, and every extra construct is another way for the card to end
// up looking broken on a phone.

const TOKEN_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

export type NoteContext = Record<string, string | number>;

/**
 * Substitute `{{token}}` against `ctx`.
 *
 * An unknown token renders as `[mangler verdi: token]` — the same convention
 * the terms renderer uses. Admin sees the placeholder in the live page and can
 * fix the typo; nothing throws, because a mistyped token in a marketing note
 * is not worth a 500 on the front page.
 */
export function renderNoteTokens(template: string, ctx: NoteContext): string {
  return template.replace(TOKEN_RE, (_match, key: string) => {
    const value = ctx[key];
    if (value === undefined || value === '') return `[mangler verdi: ${key}]`;
    return String(value);
  });
}

export interface NoteSegment {
  text: string;
  bold: boolean;
}

/**
 * Split a rendered note into plain and bold runs.
 *
 * An unclosed `**` is treated as literal text rather than bolding the rest of
 * the note: a half-typed edit should look like a typo, not reformat the card.
 */
export function parseNoteSegments(rendered: string): NoteSegment[] {
  const segments: NoteSegment[] = [];
  let rest = rendered;

  while (rest.length > 0) {
    const open = rest.indexOf('**');
    if (open === -1) break;
    const close = rest.indexOf('**', open + 2);
    if (close === -1) break;

    if (open > 0) segments.push({ text: rest.slice(0, open), bold: false });
    const bold = rest.slice(open + 2, close);
    // `****` produces an empty run — drop it rather than emit an empty <strong>.
    if (bold.length > 0) segments.push({ text: bold, bold: true });
    rest = rest.slice(close + 2);
  }

  if (rest.length > 0) segments.push({ text: rest, bold: false });
  return segments;
}

/** Convenience: substitute tokens, then split into runs. */
export function renderNote(template: string, ctx: NoteContext): NoteSegment[] {
  return parseNoteSegments(renderNoteTokens(template, ctx));
}
