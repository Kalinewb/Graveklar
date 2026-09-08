import { NextRequest, NextResponse } from 'next/server';
import { clearSessionCookieOptions, isSecureRequest } from '@/lib/admin-auth';

export async function POST(request: NextRequest) {
  const res = NextResponse.json({ success: true });
  // Match the flags the cookie was issued with so the clear lands on the same
  // cookie the login set.
  const opts = clearSessionCookieOptions(isSecureRequest(request));
  res.cookies.set(opts.name, opts.value, {
    httpOnly: opts.httpOnly,
    secure: opts.secure,
    sameSite: opts.sameSite,
    path: opts.path,
    maxAge: opts.maxAge,
  });
  return res;
}
