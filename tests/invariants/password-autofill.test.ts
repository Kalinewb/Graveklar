/**
 * L0 — a lint-style guard over the admin login markup. Renders nothing.
 *
 * Bitwarden (and every other password manager) does not read our intent, it
 * reads attributes. Two of its rules bit us:
 *
 *   - When it collects a page it **discards password inputs that are
 *     `readonly` or `disabled`**. The login form used to set
 *     `readOnly={requiresTotp}` on the password once the 2FA step appeared, so
 *     the re-scan triggered by that very DOM change found zero password fields
 *     and the form stopped looking like a login — no inline menu, nothing to
 *     fill.
 *   - It matches a field on `name`/`id`/`placeholder`, and its save prompt
 *     reads the submitted field names. A password input with no `name` is a
 *     weaker match and cannot be offered for saving.
 *
 * A password field also needs a username field beside it before Chrome or
 * Bitwarden will classify the form as a login at all; the admin area has a
 * single shared account, so that field is hidden but present.
 *
 * These are one-character regressions to reintroduce, so they are asserted
 * from the source text rather than trusted to review.
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../setup';

const LOGIN_PAGE = path.join(REPO_ROOT, 'src/app/admin/login/page.tsx');
const TOTP_MODAL = path.join(REPO_ROOT, 'src/components/admin/TotpPromptModal.tsx');

const read = (file: string) => fs.readFileSync(file, 'utf8');

/**
 * `source` split into lines with comments blanked out, so the guard below
 * matches real calls and not the comments that explain why they are banned.
 * Line numbering is preserved.
 */
function codeLines(source: string): string[] {
  let inBlock = false;
  return source.split('\n').map((line) => {
    let out = '';
    for (let i = 0; i < line.length; i++) {
      if (inBlock) {
        if (line.startsWith('*/', i)) { inBlock = false; i++; }
        continue;
      }
      if (line.startsWith('/*', i)) { inBlock = true; i++; continue; }
      if (line.startsWith('//', i)) break;
      out += line[i];
    }
    return out;
  });
}

/**
 * Every `<Input …>` / `<input …>` element in `source`, as the raw text of its
 * opening tag. Good enough for attribute presence: the codebase writes one
 * attribute per line and never nests a tag inside an attribute value.
 */
function inputTags(source: string): string[] {
  return [...source.matchAll(/<[Ii]nput\b[\s\S]*?\/>/g)].map((m) => m[0]);
}

const isPasswordInput = (tag: string) => /type=(["'])password\1/.test(tag);

describe('admin password fields stay autofillable (L0)', () => {
  it('never marks a password input readOnly or disabled', () => {
    for (const file of [LOGIN_PAGE, TOTP_MODAL]) {
      const offenders = inputTags(read(file))
        .filter(isPasswordInput)
        .filter((tag) => /\b(readOnly|disabled)\b/.test(tag));
      expect(offenders, `${path.relative(REPO_ROOT, file)} has a readonly/disabled password input`)
        .toEqual([]);
    }
  });

  it('gives every password input a name and an autocomplete token', () => {
    for (const file of [LOGIN_PAGE, TOTP_MODAL]) {
      const label = path.relative(REPO_ROOT, file);
      const passwords = inputTags(read(file)).filter(isPasswordInput);
      expect(passwords.length, `${label} should still have password inputs`).toBeGreaterThan(0);
      for (const tag of passwords) {
        expect(tag, `${label}: password input without name=`).toMatch(/\bname=/);
        expect(tag, `${label}: password input without autoComplete=`).toMatch(
          /autoComplete=(["'])(current-password|new-password)\1/,
        );
      }
    }
  });

  it('pairs the login and change-password forms with a username field', () => {
    const source = read(LOGIN_PAGE);
    const usernames = inputTags(source).filter((tag) =>
      /autoComplete=(["'])username\1/.test(tag),
    );
    // One for the login form, one for the "velg nytt passord" form.
    expect(usernames).toHaveLength(2);
    for (const tag of usernames) {
      expect(tag).toMatch(/\bname=(["'])username\1/);
      // Hidden, not removed: Bitwarden skips non-viewable inputs when filling,
      // so it costs nothing and buys the login classification.
      expect(tag).toMatch(/\bhidden\b/);
      expect(tag).toMatch(/\breadOnly\b/);
    }
  });

  it('keeps the TOTP inputs discoverable as one-time-code fields', () => {
    for (const file of [LOGIN_PAGE, TOTP_MODAL]) {
      const label = path.relative(REPO_ROOT, file);
      const otp = inputTags(read(file)).filter((tag) =>
        /autoComplete=(["'])one-time-code\1/.test(tag),
      );
      expect(otp.length, `${label} should have a one-time-code input`).toBeGreaterThan(0);
      for (const tag of otp) {
        expect(tag, `${label}: one-time-code input without name="totp"`).toMatch(
          /\bname=(["'])totp\1/,
        );
        // type="number" hides the inline autofill menu in Chrome; keep text.
        expect(tag, `${label}: one-time-code input must stay type="text"`).toMatch(
          /type=(["'])text\1/,
        );
      }
    }
  });
});

describe('clipboard copy buttons go through the shared helper (L0)', () => {
  /**
   * `navigator.clipboard` is undefined outside a secure context, and this panel
   * is reachable over plain HTTP on a LAN — a direct call throws there and the
   * button silently does nothing. `src/lib/clipboard.ts` is the only place
   * allowed to touch the API.
   */
  it('has no direct navigator.clipboard use outside src/lib/clipboard.ts', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (full === path.join(REPO_ROOT, 'src/lib/clipboard.ts')) continue;
        codeLines(read(full)).forEach((line, i) => {
          if (/navigator\s*\??\s*\.\s*clipboard/.test(line)) {
            offenders.push(`${path.relative(REPO_ROOT, full)}:${i + 1}`);
          }
        });
      }
    };
    walk(path.join(REPO_ROOT, 'src'));
    expect(offenders).toEqual([]);
  });
});
