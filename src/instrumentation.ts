// Next.js instrumentation — `register()` runs once when the server process
// boots.
//
// Reliable unpaid-booking cleanup. The in-process lazy sweep
// (runCleanupIfDue) only fires when /api/availability, /api/bookings or the
// home page happen to be hit, throttled to once a minute. On a quiet site an
// expired pending booking could sit uncancelled long past its deadline — the
// "didn't auto-cancel at the deadline" symptom. A self-hosted `next start`
// process is long-lived, so a plain setInterval guarantees the sweep runs
// every minute regardless of traffic. It calls runCleanupIfDue(), so it
// shares the same throttle / in-flight guard as traffic-triggered runs and
// never double-sweeps.

export async function register() {
  // Node runtime only — the edge runtime has no DB access and no long-lived
  // process to host a timer.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const g = globalThis as typeof globalThis & {
    __graveklarCleanupTimer?: ReturnType<typeof setInterval>;
  };
  // Guard against double-registration (dev HMR can call register() again).
  if (g.__graveklarCleanupTimer) return;

  const { runCleanupIfDue } = await import('@/lib/cleanup');
  const tick = () =>
    runCleanupIfDue().catch((err) => console.error('[cleanup-interval] failed:', err));

  // Let the server settle, then sweep once a minute (matches the cleanup
  // throttle window).
  setTimeout(tick, 15_000);
  g.__graveklarCleanupTimer = setInterval(tick, 60_000);
}
