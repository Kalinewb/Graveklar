import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifySessionToken, COOKIE_NAME } from '@/lib/admin-auth';

function requiresAdminApi(pathname: string, method: string): boolean {
  if (pathname.startsWith('/api/bookings/')) return true;
  if (pathname === '/api/bookings' && method === 'GET') return true;
  if (pathname === '/api/config' && method === 'POST') return true;
  if (pathname.startsWith('/api/unavailable')) return true;
  return false;
}

const PUBLIC_ADMIN_API = new Set(['/api/admin/login', '/api/admin/logout']);

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get(COOKIE_NAME)?.value;
  const authed = await verifySessionToken(token);

  if (pathname === '/admin/login') {
    if (authed) return NextResponse.redirect(new URL('/admin', request.url));
    return NextResponse.next();
  }

  if (pathname.startsWith('/admin')) {
    if (!authed) {
      const login = new URL('/admin/login', request.url);
      login.searchParams.set('from', pathname);
      return NextResponse.redirect(login);
    }
    return NextResponse.next();
  }

  // The bare collection path is admin-only too. It is inside the matcher, so
  // the proxy runs for it — but every branch used to test for the trailing
  // slash, so `/api/admin` fell through to NextResponse.next(). Nothing is
  // served there today (Next answers 404), which is precisely why the gap was
  // invisible: the moment someone adds src/app/api/admin/route.ts it would be
  // public (H-2).
  if (pathname === '/api/admin' || pathname.startsWith('/api/admin/')) {
    if (!PUBLIC_ADMIN_API.has(pathname) && !authed) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.next();
  }

  if (requiresAdminApi(pathname, request.method)) {
    if (!authed) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/admin/:path*',
    '/api/admin/:path*',
    '/api/bookings',
    '/api/bookings/:path*',
    '/api/config',
    '/api/unavailable',
    '/api/unavailable/:path*',
  ],
};
