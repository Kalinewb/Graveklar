import { db } from '@/lib/db';
import type { NextRequest } from 'next/server';
import { clientIdentity } from '@/lib/client-ip';

export interface AuditChange {
  key: string;
  from: string | number | boolean | null;
  to:   string | number | boolean | null;
}

export async function writeAuditLog(opts: {
  action: string;
  changes: AuditChange[];
  request?: NextRequest;
  actor?: string;
}): Promise<void> {
  const { action, changes, request, actor = 'admin' } = opts;
  if (changes.length === 0) return;
  // Same identity the rate limiters use: never a header the client can set
  // on its own (H-5). Absent a request there is nothing to record.
  const ip = request ? clientIdentity(request) : null;
  try {
    await db.adminAuditLog.create({
      data: {
        actor,
        action,
        changes: JSON.stringify(changes),
        ip,
      },
    });
  } catch (err) {
    // Audit failure is logged but not fatal — better to keep the user's
    // change than to refuse the save because audit storage hiccupped.
    console.error('[audit-log] write failed', { action, error: (err as Error).message });
  }
}
