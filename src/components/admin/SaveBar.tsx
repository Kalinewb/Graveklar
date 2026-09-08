'use client';

import { Check, Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  /** How many fields differ from what the server currently holds. */
  dirtyCount: number;
  /** True while the POST is in flight. */
  isSaving: boolean;
  /** True for a few seconds after a successful save. */
  justSaved: boolean;
  onSave: () => void;
  onReset: () => void;
  /** Extra note rendered under the row — e.g. "saves every price group". */
  hint?: string;
}

/**
 * The save row for an admin settings panel.
 *
 * The panel it sits under can be a screenful long, and the old row gave no
 * answer to the only question an admin actually has here: is what I'm looking
 * at what the server has? The button was always enabled, so pressing it told
 * you nothing either — a no-op save and a real save looked identical. The
 * "Innstillinger lagret!" banner lived at the top of the panel, out of view
 * from the button that produced it, and cleared itself after three seconds.
 *
 * So the state is stated permanently, right where the action is: how many
 * fields are unsaved, or that everything is saved. The button is enabled only
 * when there is something to save, which makes it a readable signal on its own.
 */
export default function SaveBar({ dirtyCount, isSaving, justSaved, onSave, onReset, hint }: Props) {
  const dirty = dirtyCount > 0;

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={onSave} disabled={isSaving || !dirty} className="gap-2">
          {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {isSaving ? 'Lagrer…' : 'Lagre'}
        </Button>
        <Button variant="outline" onClick={onReset} disabled={isSaving || !dirty}>
          Forkast endringer
        </Button>

        {isSaving ? null : dirty ? (
          <span className="text-sm font-medium text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
            {dirtyCount === 1 ? '1 endring ikke lagret' : `${dirtyCount} endringer ikke lagret`}
          </span>
        ) : justSaved ? (
          <span className="text-sm font-medium text-green-700 dark:text-green-400 flex items-center gap-1.5">
            <Check className="w-4 h-4 shrink-0" />
            Lagret
          </span>
        ) : (
          <span className="text-sm text-muted-foreground flex items-center gap-1.5">
            <Check className="w-4 h-4 shrink-0 opacity-60" />
            Alt er lagret
          </span>
        )}
      </div>
      {hint && <p className="text-xs text-muted-foreground mt-2">{hint}</p>}
    </div>
  );
}
