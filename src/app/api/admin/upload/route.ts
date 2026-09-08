import { NextRequest, NextResponse } from 'next/server';
import { createRateLimiter } from '@/lib/rate-limit';
import { sniffFileType } from '@/lib/upload-sniff';
import { clientIdentity } from '@/lib/client-ip';
import { storeUpload } from '@/lib/upload-store';

const checkLimit = createRateLimiter(20, 5 * 60 * 1000);

// SVG is intentionally excluded. SVGs are XML documents and can carry
// <script> payloads that execute when the file is opened directly (as
// `/api/uploads/foo.svg` would serve them). Stripping scripts safely is
// non-trivial; the simpler, safer choice is to refuse SVG.
//
// Accepted: JPG, PNG, WebP, GIF, HEIC and PDF (equipment manuals — served
// from /api/uploads as application/pdf). The stored extension is derived
// from the file's magic bytes, never from the client-supplied MIME type or
// filename (see lib/upload-sniff.ts).
const MAX_SIZE = 20 * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    const ip = clientIdentity(request);
    if (checkLimit(ip)) return NextResponse.json({ error: 'For mange opplastinger. Prøv igjen om litt.' }, { status: 429 });

    const form = await request.formData();
    const file = form.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'Ingen fil lastet opp.' }, { status: 400 });
    if (file.size > MAX_SIZE) return NextResponse.json({ error: `Filen er for stor (${Math.round(file.size/1024/1024)} MB, maks 20 MB).` }, { status: 400 });

    const fileExt = file.name.split('.').pop()?.toLowerCase() || '';
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = sniffFileType(bytes);
    if (!ext) {
      return NextResponse.json(
        { error: `Filtype ikke støttet (${file.type || 'ukjent'}${fileExt ? `, .${fileExt}` : ''}). Tillatt: JPG, PNG, WebP, GIF, HEIC og PDF.` },
        { status: 400 },
      );
    }
    // `upload-<random>.<ext>`, created exclusively: names are unguessable
    // (H-7) and a second upload can never overwrite the first (H-8). These
    // files are public by design — machine photos, manuals, the logo — so the
    // random name is defence in depth, not the access control.
    const filename = await storeUpload('upload', ext, bytes);

    return NextResponse.json({ url: `/api/uploads/${filename}` });
  } catch (err) {
    console.error('Upload error:', err);
    return NextResponse.json({ error: 'Opplasting feilet.' }, { status: 500 });
  }
}
