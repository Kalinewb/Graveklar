'use client';

import {
  computeChecklistStats,
  formatChecklistAnswerValue,
  formatStatNumber,
  isItemActive,
  isItemFilled,
  photoUrls,
  type ChecklistPhaseLike,
} from '@/lib/checklist';

interface ChecklistItem {
  id: string;
  label: string;
  answerType: string;
  unit?: string | null;
  conditionItemId?: string | null;
  conditionValue?: string | null;
  minPhotos?: number | null;
}

interface Phase extends ChecklistPhaseLike {
  items: ChecklistItem[];
}

interface RenterSubmission {
  phaseId: string;
  intervalKey: string;
  phaseName: string;
  intervalLabel: string;
  data: Record<string, unknown>;
  submittedAt: string;
}

interface Props {
  businessName: string;
  orgNumber: string;
  logoUrl?: string;
  reference: string;
  customerName: string;
  customerPhone: string;
  equipmentName: string;
  startDateLabel: string;
  selfPickup: boolean;
  operatorPhases: Phase[];
  allPhases: Phase[];
  operatorData: Record<string, unknown>;
  renterSubmissions: RenterSubmission[];
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString('nb-NO', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

export function ChecklistSandboxPrint({
  businessName,
  orgNumber,
  logoUrl,
  reference,
  customerName,
  customerPhone,
  equipmentName,
  startDateLabel,
  selfPickup,
  operatorPhases,
  allPhases,
  operatorData,
  renterSubmissions,
}: Props) {
  const stats = computeChecklistStats(operatorPhases, operatorData);
  const lockedAt = typeof operatorData.__lockedAt === 'string' ? operatorData.__lockedAt : null;
  const allOperatorLocked =
    operatorPhases.length > 0
    && operatorPhases.every((p) => operatorData[`__phase_locked_${p.id}`] === true);

  return (
    <div className="hidden print:block">
      <div className="px-8 pt-8 pb-4 border-b-2 border-black">
        <div className="flex justify-between items-start">
          <div className="flex items-center gap-3">
            {logoUrl && (
               
              <img src={logoUrl} alt={businessName} className="h-12 w-auto object-contain" />
            )}
            <div>
              <div className="text-2xl font-bold">{businessName}</div>
              {orgNumber && <div className="text-sm text-gray-600">Org.nr {orgNumber}</div>}
            </div>
          </div>
          <div className="text-right">
            <div className="text-lg font-bold">Sjekkliste (sandbox)</div>
            <div className="text-sm">{reference}</div>
            <div className="text-sm text-gray-600">
              {lockedAt
                ? `Fullført ${fmtDateTime(lockedAt)}`
                : `Utskrift ${fmtDateTime(new Date().toISOString())}`}
            </div>
          </div>
        </div>
      </div>

      <div className="px-8 py-4 border-b">
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm max-w-lg">
          <div>
            <span className="text-gray-500 text-xs">Kunde</span>
            <div className="font-medium">{customerName}</div>
          </div>
          <div>
            <span className="text-gray-500 text-xs">Telefon</span>
            <div className="font-medium">{customerPhone}</div>
          </div>
          <div>
            <span className="text-gray-500 text-xs">Utstyr</span>
            <div className="font-medium">{equipmentName}</div>
          </div>
          <div>
            <span className="text-gray-500 text-xs">Simulert dag</span>
            <div className="font-medium">{startDateLabel}</div>
          </div>
          <div>
            <span className="text-gray-500 text-xs">Levering</span>
            <div className="font-medium">{selfPickup ? 'Selvhenting' : 'Levering (test)'}</div>
          </div>
        </div>
      </div>

      {operatorPhases.map((p) => {
        const lockedAtPhase = operatorData[`__phase_locked_at_${p.id}`];
        const visible = p.items.filter((i) => isItemActive(i, operatorData, p.items));
        if (visible.length === 0 && lockedAtPhase == null) return null;

        return (
          <div key={p.id} className="px-8 py-4 mb-2">
            <div className="flex items-baseline justify-between border-b border-gray-300 pb-1 mb-3">
              <h2 className="text-lg font-bold">{p.name}</h2>
              {typeof lockedAtPhase === 'string' && (
                <span className="text-xs text-gray-600">Fullført {fmtDateTime(lockedAtPhase)}</span>
              )}
            </div>
            <div className="space-y-1.5">
              {visible.map((item) => {
                const value = operatorData[item.id];
                return (
                  <div key={item.id} className="text-sm mb-2">
                    <div className="flex items-start gap-2">
                      <span className="w-5 h-5 border border-gray-400 rounded flex items-center justify-center shrink-0 mt-0.5 text-xs">
                        {item.answerType === 'checkbox' && value === true ? '✓' : ''}
                      </span>
                      <span className="flex-1">{item.label}</span>
                      {(item.answerType === 'yesno' || item.answerType === 'number' || item.answerType === 'measurement' || item.answerType === 'text')
                        && isItemFilled(item, value) && (
                        <span className="font-medium">
                          {formatChecklistAnswerValue(item, value)}
                          {item.unit && item.answerType === 'measurement' ? ` ${item.unit}` : ''}
                        </span>
                      )}
                    </div>
                    {item.answerType === 'photo' && photoUrls(value).length > 0 && (
                      <div className="ml-7 mt-1 flex flex-wrap gap-2">
                        {photoUrls(value).map((url) => (
                           
                          <img
                            key={url}
                            src={url}
                            alt={item.label}
                            className="max-w-[200px] max-h-[150px] rounded border border-gray-300 object-cover"
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {renterSubmissions.length > 0 && (
        <div className="px-8 py-4 mb-2">
          <h2 className="text-lg font-bold border-b border-gray-300 pb-1 mb-3">Leietaker / vedlikehold</h2>
          {renterSubmissions.map((sub) => {
            const phase = allPhases.find((p) => p.id === sub.phaseId);
            const items = phase?.items ?? [];
            return (
              <div key={`${sub.phaseId}:${sub.intervalKey}:${sub.submittedAt}`} className="mb-4">
                <h3 className="text-sm font-bold mb-1">{sub.phaseName}</h3>
                <p className="text-xs text-gray-600 mb-2">
                  {sub.intervalLabel} · {fmtDateTime(sub.submittedAt)}
                </p>
                <div className="space-y-1.5">
                  {items
                    .filter((i) => isItemActive(i, sub.data, items))
                    .map((item) => {
                      const value = sub.data[item.id];
                      return (
                        <div key={item.id} className="text-sm">
                          <div className="flex items-start gap-2">
                            <span className="w-5 h-5 border border-gray-400 rounded flex items-center justify-center shrink-0 mt-0.5 text-xs">
                              {isItemFilled(item, value) ? '✓' : ''}
                            </span>
                            <span className="flex-1">{item.label}</span>
                            {(item.answerType === 'yesno' || item.answerType === 'number' || item.answerType === 'measurement' || item.answerType === 'text')
                              && isItemFilled(item, value) && (
                              <span className="font-medium">{formatChecklistAnswerValue(item, value)}</span>
                            )}
                          </div>
                          {item.answerType === 'photo' && photoUrls(value).length > 0 && (
                            <div className="ml-7 mt-1 flex flex-wrap gap-2">
                              {photoUrls(value).map((url) => (
                                 
                                <img
                                  key={url}
                                  src={url}
                                  alt={item.label}
                                  className="max-w-[200px] max-h-[150px] rounded border border-gray-300 object-cover"
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {stats.length > 0 && (
        <div className="px-8 py-4 mb-2">
          <h2 className="text-lg font-bold border-b border-gray-300 pb-1 mb-3">Statistikk</h2>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-gray-600 border-b border-gray-300">
                <th className="py-1 pr-3 font-medium">Måling</th>
                <th className="py-1 px-3 font-medium">Start</th>
                <th className="py-1 px-3 font-medium">Slutt</th>
                <th className="py-1 pl-3 font-medium text-right">Differanse</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.key} className="border-b border-gray-200">
                  <td className="py-1.5 pr-3">
                    {s.label}
                    <span className="text-gray-500"> ({s.startPhase} → {s.endPhase})</span>
                  </td>
                  <td className="py-1.5 px-3 tabular-nums">
                    {formatStatNumber(s.startValue)}{s.unit ? ` ${s.unit}` : ''}
                  </td>
                  <td className="py-1.5 px-3 tabular-nums">
                    {formatStatNumber(s.endValue)}{s.unit ? ` ${s.unit}` : ''}
                  </td>
                  <td className="py-1.5 pl-3 tabular-nums text-right font-bold">
                    {formatStatNumber(s.delta)}{s.unit ? ` ${s.unit}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="px-8 mt-4 pt-4 border-t border-gray-300 text-xs text-center text-gray-600">
        {businessName}
        {orgNumber ? ` · Org.nr ${orgNumber}` : ''}
        {' · '}
        {reference}
        {' · '}
        {allOperatorLocked && lockedAt
          ? `Fullført ${fmtDateTime(lockedAt)}`
          : 'Sandbox — ikke lagret'}
      </div>
    </div>
  );
}
