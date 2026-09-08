'use client';

import { useEffect, useState } from 'react';
import { GripVertical, Wrench, Trash2, Plus } from 'lucide-react';
import { Toggle } from '@/components/admin-ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChecklistItemsList, type ChecklistItemRow } from '@/components/admin/ChecklistItemsList';
import { getPhaseListBadge } from '@/components/admin/ChecklistPhaseFormSheet';

export interface ChecklistPhaseRow {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  isCompletionTrigger?: boolean;
  audience?: string;
  items: ChecklistItemRow[];
}

interface Props {
  phases: ChecklistPhaseRow[];
  onTogglePhase: (phase: ChecklistPhaseRow) => void;
  onEditPhase: (phase: ChecklistPhaseRow) => void;
  onDeletePhase: (id: string) => void;
  onReordered: () => void | Promise<void>;
  onEditItem: (phaseId: string, item: ChecklistItemRow) => void;
  onDeleteItem: (id: string) => void;
  onToggleItem: (item: ChecklistItemRow) => void;
  onItemsReordered: () => void | Promise<void>;
  onAddItem: (phaseId: string) => void;
}

function reorder<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [removed] = next.splice(from, 1);
  next.splice(to, 0, removed);
  return next;
}

export function ChecklistPhasesList({
  phases: initialPhases,
  onTogglePhase,
  onEditPhase,
  onDeletePhase,
  onReordered,
  onEditItem,
  onDeleteItem,
  onToggleItem,
  onItemsReordered,
  onAddItem,
}: Props) {
  const [phases, setPhases] = useState(initialPhases);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPhases(initialPhases);
  }, [initialPhases]);

  const persistOrder = async (ordered: ChecklistPhaseRow[]) => {
    setSaving(true);
    try {
      const res = await fetch('/api/admin/checklist-phases/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ phaseIds: ordered.map((p) => p.id) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Omorganisering feilet');
      await onReordered();
    } catch {
      setPhases(initialPhases);
    } finally {
      setSaving(false);
    }
  };

  const handleDrop = (toIndex: number) => {
    if (dragIndex === null || dragIndex === toIndex) {
      setDragIndex(null);
      setOverIndex(null);
      return;
    }
    const next = reorder(phases, dragIndex, toIndex).map((phase, idx) => ({ ...phase, sortOrder: idx }));
    setPhases(next);
    setDragIndex(null);
    setOverIndex(null);
    void persistOrder(next);
  };

  return (
    <>
      {phases.map((phase, index) => (
        <div
          key={phase.id}
          onDragOver={(e) => {
            e.preventDefault();
            if (dragIndex !== null) setOverIndex(index);
          }}
          onDragLeave={() => {
            if (overIndex === index) setOverIndex(null);
          }}
          onDrop={(e) => {
            e.preventDefault();
            handleDrop(index);
          }}
          className={`border border-border rounded-xl overflow-hidden transition-colors ${
            !phase.isActive ? 'opacity-60' : ''
          } ${dragIndex === index ? 'opacity-40' : ''} ${
            overIndex === index && dragIndex !== null && dragIndex !== index
              ? 'ring-2 ring-primary/40'
              : ''
          } ${saving ? 'pointer-events-none' : ''}`}
        >
          <div className="flex items-center gap-2 px-3 py-2.5 bg-muted/40 border-b border-border">
            <button
              type="button"
              draggable={!saving}
              onDragStart={(e) => {
                setDragIndex(index);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', phase.id);
              }}
              onDragEnd={() => {
                setDragIndex(null);
                setOverIndex(null);
              }}
              className="p-1 -ml-1 text-muted-foreground/50 hover:text-muted-foreground cursor-grab active:cursor-grabbing touch-none shrink-0"
              title="Dra for å endre rekkefølge"
              aria-label="Dra for å endre rekkefølge"
            >
              <GripVertical className="w-4 h-4" />
            </button>
            <Toggle value={phase.isActive} onChange={() => onTogglePhase(phase)} labelOn="" labelOff="" />
            <span className="font-semibold text-sm flex-1">{phase.name}</span>
            {phase.isCompletionTrigger && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Auto-fullfør</Badge>
            )}
            {(() => {
              const badge = getPhaseListBadge(phase);
              if (!badge) return null;
              const tone =
                phase.audience === 'split'
                  ? 'text-violet-600 border-violet-400/40'
                  : phase.audience === 'renter'
                    ? 'text-blue-600 border-blue-400/40'
                    : 'text-muted-foreground';
              return (
                <Badge variant="outline" className={`text-[10px] px-1.5 py-0 max-w-[min(100%,14rem)] truncate ${tone}`}>
                  {badge}
                </Badge>
              );
            })()}
            <span className="text-xs text-muted-foreground">{phase.items.filter((i) => i.isActive).length} aktive · {phase.items.length} totalt</span>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => onEditPhase(phase)} title="Rediger fase">
              <Wrench className="w-3.5 h-3.5" />
            </Button>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => onDeletePhase(phase.id)} title="Slett fase">
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
          <div className="p-2 space-y-0.5">
            <ChecklistItemsList
              phaseId={phase.id}
              items={phase.items}
              onEdit={(item) => onEditItem(phase.id, item)}
              onDelete={onDeleteItem}
              onToggle={onToggleItem}
              onReordered={onItemsReordered}
            />
            <button
              onClick={() => onAddItem(phase.id)}
              className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors mt-1"
            >
              <Plus className="w-3.5 h-3.5" />Legg til punkt
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
