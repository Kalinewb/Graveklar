import { db } from '../src/lib/db';

async function main() {
  const b = await db.booking.findFirst({ where: { status: 'confirmed' } });
  if (!b) {
    console.log('no confirmed booking');
    return;
  }
  console.log('testing update on', b.reference, b.id);
  try {
    const updated = await db.booking.update({
      where: { id: b.id },
      data: {
        contractSigningMethod: 'digipost',
        contractSigningStatus: 'signed',
        contractSignedAt: new Date(),
      },
    });
    const payload = {
      success: true,
      booking: {
        ...updated,
        startDate: updated.startDate.toISOString(),
        createdAt: updated.createdAt.toISOString(),
        termsAcceptedAt: updated.termsAcceptedAt?.toISOString() ?? null,
        fullyPaidAt: updated.fullyPaidAt?.toISOString() ?? null,
        contractSentAt: updated.contractSentAt?.toISOString() ?? null,
        contractSignedAt: updated.contractSignedAt?.toISOString() ?? null,
      },
    };
    JSON.stringify(payload);
    console.log('ok', updated.contractSigningStatus);
  } catch (e) {
    console.error('FAIL', e);
  }
}

main()
  .finally(() => db.$disconnect());
