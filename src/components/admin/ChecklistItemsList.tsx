'use client';

import { useEffect, useState } from 'react';
import { GripVertical, Wrench, Trash2, GitBranch } from 'lucide-react';
import { Toggle } from '@/components/admin-ui';
import { AnswerTypePill } from '@/components/admin/AnswerTypePill';
import { Badge } from '@/components/ui/badge';

export interface ChecklistItemRow {
  id: string;
  phaseId: string;
  label: string;
  answerType: string;
  unit?: string;
  sortOrder: number;
  isActive: boolean;
  conditionItemId?: string | null;
}

interface Props {
  phaseId: string;
  items: ChecklistItemRow[];
  onEdit: (item: ChecklistItemRow) => void;
  onDelete: (id: string) => void;
  onToggle: (item: ChecklistItemRow) => void;
  onReordered: () => void | Promise<void>;
}

function reorder<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [removed] = next.splice(from, 1);
  next.splice(to, 0, removed);
  return next;
}

export function ChecklistItemsList({
  phaseId,
  items: initialItems,
  onEdit,
  onDelete,
  onToggle,
  onReordered,
}: Props) {
  const [items, setItems] = useState(initialItems);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setItems(initialItems);
  }, [initialItems]);

  const persistOrder = async (ordered: ChecklistItemRow[]) => {
    setSaving(true);
    try {
      const res = await fetch('/api/admin/checklist-items/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ phaseId, itemIds: ordered.map((i) => i.id) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Omorganisering feilet');
      await onReordered();
    } catch {
      setItems(initialItems);
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
    const next = reorder(items, dragIndex, toIndex).map((item, idx) => ({ ...item, sortOrder: idx }));
    setItems(next);
    setDragIndex(null);
    setOverIndex(null);
    void persistOrder(next);
  };

  return (
    <>
      {items.map((item, index) => (
        <div
          key={item.id}
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
          className={`flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/50 group transition-colors ${
            !item.isActive ? 'opacity-50' : ''
          } ${dragIndex === index ? 'opacity-40' : ''} ${
            overIndex === index && dragIndex !== null && dragIndex !== index
              ? 'ring-2 ring-primary/40 bg-primary/5'
              : ''
          } ${saving ? 'pointer-events-none' : ''}`}
        >
          <button
            type="button"
            draggable={!saving}
            onDragStart={(e) => {
              setDragIndex(index);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', item.id);
            }}
            onDragEnd={() => {
              setDragIndex(null);
              setOverIndex(null);
            }}
            className="p-1 text-muted-foreground/50 hover:text-muted-foreground cursor-grab active:cursor-grabbing touch-none shrink-0"
            title="Dra for å endre rekkefølge"
            aria-label="Dra for å endre rekkefølge"
          >
            <GripVertical className="w-4 h-4" />
          </button>
          <div className="scale-75 shrink-0">
            <Toggle value={item.isActive} onChange={() => onToggle(item)} labelOn="" labelOff="" />
          </div>
          <span className={`text-sm flex-1 min-w-0 truncate ${!item.isActive ? 'line-through text-muted-foreground' : ''}`}>
            {item.label}
          </span>
          {item.conditionItemId && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 gap-0.5 shrink-0">
              <GitBranch className="w-2.5 h-2.5" />betinget
            </Badge>
          )}
          <AnswerTypePill type={item.answerType} unit={item.unit} />
          <div className="flex gap-1 opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 transition-opacity shrink-0">
            <button
              type="button"
              onClick={() => onEdit(item)}
              className="p-1.5 text-muted-foreground hover:text-foreground rounded"
              title="Rediger punkt"
            >
              <Wrench className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onDelete(item.id)}
              className="p-1.5 text-muted-foreground hover:text-destructive rounded"
              title="Slett punkt"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
