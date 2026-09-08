import { NextResponse } from 'next/server';
import { loadAppConfig, publicAppConfig } from '@/lib/app-config';

export const dynamic = 'force-dynamic';

// The anonymous read of the settings. What may be published is decided by the
// code's public list (`publicAppConfig`), never by the DB row's `isPublic`
// column: `loadAppConfig()` only inserts missing keys and deletes undeclared
// ones — it never re-syncs metadata onto existing rows — so a flag that was
// true under an older APP_CONFIG_DEFAULTS, or was written by any other path,
// would otherwise keep publishing its value to the world for ever (I-1).
// `publicAppConfig` is fail-closed: a key it does not recognise is dropped.
export async function GET() {
  return NextResponse.json(publicAppConfig(await loadAppConfig()));
}
