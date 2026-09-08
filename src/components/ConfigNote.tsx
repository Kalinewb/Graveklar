import { renderNote, type NoteContext } from '@/lib/note-template';

/**
 * Renders one admin-editable note: `{{token}}` values from `ctx`, `**bold**`
 * runs as <strong>. Nothing else is interpreted, so the string cannot inject
 * markup — the segments go in as text nodes.
 *
 * `fallback` is the copy shipped in app-config-defaults; it renders when the
 * setting has never been saved on an existing install, so an older database
 * shows the same card as a fresh one instead of a blank box.
 */
export function ConfigNote({
  template,
  fallback,
  ctx,
  className,
}: {
  template?: string;
  fallback: string;
  ctx: NoteContext;
  className?: string;
}) {
  const source = (template ?? '').trim() || fallback;
  const segments = renderNote(source, ctx);
  if (segments.length === 0) return null;

  return (
    <div className={className}>
      {segments.map((segment, i) =>
        segment.bold ? (
          <strong key={i} className="text-foreground font-semibold">
            {segment.text}
          </strong>
        ) : (
          <span key={i}>{segment.text}</span>
        )
      )}
    </div>
  );
}
