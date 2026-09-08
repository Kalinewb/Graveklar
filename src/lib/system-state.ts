import { db } from '@/lib/db';

// SystemState holds derived/cached machine state, NEVER admin intent.
// Keys here are versioned operationally (delivery_origin, etc.) and the
// payload is JSON-encoded so the schema stays flat at the row level.

export interface DeliveryOriginState {
  address: string;
  displayName?: string;
  lat: number;
  lng: number;
  resolvedAt: string;
}

const KEY_DELIVERY_ORIGIN = 'delivery_origin';

export async function getDeliveryOrigin(): Promise<DeliveryOriginState | null> {
  const row = await db.systemState.findUnique({ where: { key: KEY_DELIVERY_ORIGIN } });
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as DeliveryOriginState;
    if (typeof parsed?.lat !== 'number' || typeof parsed?.lng !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function setDeliveryOrigin(state: DeliveryOriginState): Promise<void> {
  await db.systemState.upsert({
    where: { key: KEY_DELIVERY_ORIGIN },
    create: { key: KEY_DELIVERY_ORIGIN, value: JSON.stringify(state) },
    update: { value: JSON.stringify(state) },
  });
}
