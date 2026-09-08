import { describe, it, expect } from 'vitest';
import { sniffFileType } from '@/lib/upload-sniff';

const pad = (bytes: number[]) => new Uint8Array([...bytes, ...new Array(Math.max(0, 16 - bytes.length)).fill(0)]);
const str = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

describe('sniffFileType', () => {
  it('recognises the accepted formats by magic bytes', () => {
    expect(sniffFileType(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(sniffFileType(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(sniffFileType(pad([...str('RIFF'), 0, 0, 0, 0, ...str('WEBP')]))).toBe('webp');
    expect(sniffFileType(pad(str('GIF89a')))).toBe('gif');
    expect(sniffFileType(pad(str('%PDF-1.7')))).toBe('pdf');
    expect(sniffFileType(pad([0, 0, 0, 0x18, ...str('ftypheic')]))).toBe('heic');
  });

  it('refuses anything else, regardless of what the client claimed', () => {
    expect(sniffFileType(pad(str('<html><script>')))).toBeNull();
    expect(sniffFileType(pad(str('<?xml version="1.0"?><svg')))).toBeNull();
    expect(sniffFileType(pad([0x4d, 0x5a]))).toBeNull(); // PE executable
    expect(sniffFileType(new Uint8Array([0xff, 0xd8]))).toBeNull(); // too short to judge
  });
});
