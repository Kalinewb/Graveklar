import { db } from '@/lib/db';
import { loadAppConfig } from '@/lib/app-config';
import ChecklistSandboxClient from './ChecklistSandboxClient';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Sjekkliste-sandbox',
};

export default async function ChecklistSandboxPage() {
  const [phases, machine, appConfig] = await Promise.all([
    db.checklistPhase.findMany({
      where: { isActive: true },
      include: {
        items: {
          where: { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
      orderBy: { sortOrder: 'asc' },
    }),
    db.machine.findFirst({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: {
        documents: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
      },
    }),
    loadAppConfig(),
  ]);

  const businessName = appConfig['businessName'] || 'Graveklar';
  const orgNumber = appConfig['orgNumber'] || '';
  const logoUrl = appConfig['logoUrl'] || undefined;

  return (
    <ChecklistSandboxClient
      phases={phases.map((p) => ({
        id: p.id,
        name: p.name,
        sortOrder: p.sortOrder,
        isActive: p.isActive,
        appliesTo: p.appliesTo,
        isCompletionTrigger: p.isCompletionTrigger,
        audience: p.audience,
        intervalMode: p.intervalMode,
        intervalHours: p.intervalHours,
        items: p.items.map((i) => ({
          id: i.id,
          label: i.label,
          answerType: i.answerType,
          unit: i.unit,
          conditionItemId: i.conditionItemId,
          conditionValue: i.conditionValue,
          minPhotos: i.minPhotos,
        })),
      }))}
      equipmentName={machine?.name ?? 'Testutstyr'}
      businessName={businessName}
      orgNumber={orgNumber}
      logoUrl={logoUrl}
      machineDocuments={(machine?.documents ?? []).map((d) => ({
        title: d.title,
        fileUrl: d.fileUrl,
      }))}
    />
  );
}
