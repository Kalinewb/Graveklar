import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { isAdminAuthenticated } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';

// GET /api/admin/audit-log?action=&actor=&since=&before=&limit=
//
// Append-only audit trail of admin actions (config changes, pricing edits,
// TOTP resets, deletions). Filterable so an admin can answer "who changed
// this price?" or "what got modified last Tuesday?" without poking the DB.

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || undefined;
  const actor = searchParams.get('actor') || undefined;
  const sinceStr = searchParams.get('since');
  const beforeStr = searchParams.get('before');
  const limitRaw = parseInt(searchParams.get('limit') || String(DEFAULT_LIMIT), 10);
  const limit = Math.max(1, Math.min(MAX_LIMIT, isNaN(limitRaw) ? DEFAULT_LIMIT : limitRaw));

  const where: { action?: string; actor?: { contains: string }; createdAt?: { gte?: Date; lt?: Date } } = {};
  // `action` comes from a <select> populated with `actions` below, so it is
  // always a whole action name — and a substring match made every filter whose
  // value prefixes another one wrong (`auth.login` also returned
  // `auth.login_failed`, in the rows AND in `total`). Exact match, finding P-5.
  // `actor` stays a substring match: it is a free-text search box.
  if (action) where.action = action;
  if (actor) where.actor = { contains: actor };
  if (sinceStr || beforeStr) {
    where.createdAt = {};
    const since = sinceStr ? new Date(sinceStr) : null;
    const before = beforeStr ? new Date(beforeStr) : null;
    if (since && !isNaN(since.getTime())) where.createdAt.gte = since;
    if (before && !isNaN(before.getTime())) where.createdAt.lt = before;
  }

  const [rows, total, distinctActions] = await Promise.all([
    db.adminAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    db.adminAuditLog.count({ where }),
    // Cheap aggregate for the filter dropdown — bounded by the natural
    // small cardinality of action names.
    db.adminAuditLog.findMany({
      distinct: ['action'],
      select: { action: true },
      take: 50,
    }),
  ]);

  return NextResponse.json({
    rows: rows.map((r) => ({
      id: r.id,
      actor: r.actor,
      action: r.action,
      changes: safeParse(r.changes),
      ip: r.ip,
      createdAt: r.createdAt.toISOString(),
    })),
    total,
    limit,
    actions: distinctActions.map((d) => d.action).sort(),
  });
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}
