// Content sniffing for user uploads. The declared MIME type and the filename
// extension are both client-controlled, so the stored extension (and hence
// the Content-Type /api/uploads serves the file back with) is derived from
// the file's magic bytes only. Anything unrecognised is refused.

export type SniffedFileType = 'jpg' | 'png' | 'webp' | 'gif' | 'heic' | 'pdf';

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

function ascii(buf: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to && i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return s;
}

export function sniffFileType(buf: Uint8Array): SniffedFileType | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return 'png';
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return 'webp';
  const head6 = ascii(buf, 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'gif';
  if (ascii(buf, 0, 5) === '%PDF-') return 'pdf';
  // ISO BMFF (HEIC/HEIF from iPhones): size(4) 'ftyp'(4) major-brand(4).
  if (ascii(buf, 4, 8) === 'ftyp' && HEIF_BRANDS.has(ascii(buf, 8, 12))) return 'heic';
  return null;
}
