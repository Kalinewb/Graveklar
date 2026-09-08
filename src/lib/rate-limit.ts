/**
 * Two-part limiter: `isLimited` only reads the counter, `consume` records a
 * use. Lets a route budget what actually *succeeded* instead of every attempt.
 *
 * The single-function limiter below charges the caller for rejected requests
 * too, so a customer who picks a date inside the lead time five times in a row
 * gets locked out for the whole window without ever having created a booking.
 * Split the two and the budget only ever measures real work.
 */
export function createConsumableRateLimiter(maxRequests: number, windowMs: number) {
  const map = new Map<string, { count: number; resetAt: number }>();
  let callCount = 0;
  const sweep = (now: number) => {
    if (++callCount % 100 !== 0) return;
    for (const [key, val] of map) {
      if (now > val.resetAt) map.delete(key);
    }
  };
  return {
    isLimited(key: string): boolean {
      const now = Date.now();
      sweep(now);
      const record = map.get(key);
      if (!record || now > record.resetAt) return false;
      return record.count >= maxRequests;
    },
    consume(key: string): void {
      const now = Date.now();
      sweep(now);
      const record = map.get(key);
      if (!record || now > record.resetAt) map.set(key, { count: 1, resetAt: now + windowMs });
      else record.count += 1;
    },
  };
}

export function createRateLimiter(maxRequests: number, windowMs: number) {
  const map = new Map<string, { count: number; resetAt: number }>();
  let callCount = 0;
  return function isRateLimited(ip: string): boolean {
    const now = Date.now();
    const record = map.get(ip);
    if (!record || now > record.resetAt) {
      map.set(ip, { count: 1, resetAt: now + windowMs });
    } else {
      if (record.count >= maxRequests) return true;
      record.count++;
    }
    if (++callCount % 100 === 0) {
      for (const [key, val] of map) {
        if (now > val.resetAt) map.delete(key);
      }
    }
    return false;
  };
}
