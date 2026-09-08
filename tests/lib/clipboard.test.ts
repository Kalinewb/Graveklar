/**
 * L1 — `copyToClipboard`, the helper behind every "Kopier" button in the
 * admin panel.
 *
 * The bug it exists for: `navigator.clipboard` is only defined in a **secure
 * context**, and this panel is deliberately reachable over plain HTTP on a LAN
 * (see `isSecureRequest` in `src/lib/admin-auth.ts`). There
 * `navigator.clipboard.writeText(…)` throws a TypeError on the property
 * access, which is why the 2FA "manuell oppføring" copy button did nothing and
 * said nothing. So the two things asserted here are: the fallback runs when
 * the modern API is missing or rejects, and the helper never throws — it
 * returns false so the caller can tell the user.
 *
 * The environment is `node`, so `document`/`window` are stubbed narrowly:
 * enough of a DOM for the selection-copy path to be observable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyToClipboard } from '@/lib/clipboard';

interface FakeDom {
  execCommand: ReturnType<typeof vi.fn>;
  /** Text content of the node that was selected when `copy` was executed. */
  selectedAtCopy: string | null;
  /** Nodes still attached to the fake body after the call returned. */
  attached: () => number;
  restoredRange: unknown;
}

/** A DOM small enough to read, faithful enough for the selection-copy path. */
function installDom({ execCommandResult = true }: { execCommandResult?: boolean | Error } = {}): FakeDom {
  const children: unknown[] = [];
  let currentRange: { node: { textContent: string } } | null = null;
  const previousRange = { marker: 'user-selection' };
  let ranges: unknown[] = [previousRange];
  const state: FakeDom = {
    execCommand: vi.fn(() => {
      if (execCommandResult instanceof Error) throw execCommandResult;
      state.selectedAtCopy = currentRange?.node.textContent ?? null;
      return execCommandResult;
    }),
    selectedAtCopy: null,
    attached: () => children.length,
    restoredRange: null,
  };

  const makeNode = () => {
    const node = {
      textContent: '',
      style: {} as Record<string, string>,
      setAttribute: vi.fn(),
      remove: () => {
        const i = children.indexOf(node);
        if (i >= 0) children.splice(i, 1);
      },
    };
    return node;
  };

  const selection = {
    get rangeCount() { return ranges.length; },
    getRangeAt: (i: number) => ranges[i],
    removeAllRanges: () => { ranges = []; },
    addRange: (r: unknown) => {
      ranges.push(r);
      if (r !== previousRange) currentRange = r as { node: { textContent: string } };
      else state.restoredRange = r;
    },
  };

  vi.stubGlobal('document', {
    body: { appendChild: (n: unknown) => children.push(n) },
    createElement: makeNode,
    createRange: () => ({
      node: null as unknown,
      selectNodeContents(n: unknown) { (this as { node: unknown }).node = n; },
    }),
    execCommand: state.execCommand,
  });
  vi.stubGlobal('window', { getSelection: () => selection });
  return state;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('copyToClipboard', () => {
  it('uses the async Clipboard API when it is available', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const dom = installDom();

    await expect(copyToClipboard('JBSWY3DPEHPK3PXP')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('JBSWY3DPEHPK3PXP');
    // The fallback must not run as well — a double copy would clobber the
    // user's own selection for nothing.
    expect(dom.execCommand).not.toHaveBeenCalled();
  });

  it('falls back to a selection copy when navigator.clipboard is absent (plain-HTTP LAN)', async () => {
    vi.stubGlobal('navigator', {});
    const dom = installDom();

    await expect(copyToClipboard('JBSWY3DPEHPK3PXP')).resolves.toBe(true);
    expect(dom.execCommand).toHaveBeenCalledWith('copy');
    expect(dom.selectedAtCopy).toBe('JBSWY3DPEHPK3PXP');
  });

  it('falls back when the Clipboard API rejects (no permission, unfocused document)', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(async () => { throw new Error('NotAllowedError'); }) },
    });
    const dom = installDom();

    await expect(copyToClipboard('secret')).resolves.toBe(true);
    expect(dom.execCommand).toHaveBeenCalledWith('copy');
  });

  it('reports false instead of throwing when both routes fail', async () => {
    vi.stubGlobal('navigator', {});
    installDom({ execCommandResult: new Error('blocked') });
    await expect(copyToClipboard('secret')).resolves.toBe(false);

    vi.unstubAllGlobals();
    vi.stubGlobal('navigator', {});
    installDom({ execCommandResult: false });
    await expect(copyToClipboard('secret')).resolves.toBe(false);
  });

  it('cleans up after itself and restores the previous selection', async () => {
    vi.stubGlobal('navigator', {});
    const dom = installDom();

    await copyToClipboard('secret');
    expect(dom.attached()).toBe(0);
    expect(dom.restoredRange).toEqual({ marker: 'user-selection' });
  });

  it('is a no-op for an empty string', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const dom = installDom();

    await expect(copyToClipboard('')).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(dom.execCommand).not.toHaveBeenCalled();
  });

  it('returns false rather than throwing when there is no DOM at all (SSR)', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', undefined);
    await expect(copyToClipboard('secret')).resolves.toBe(false);
  });
});
