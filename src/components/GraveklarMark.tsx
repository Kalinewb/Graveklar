// Graveklar brand mark — excavator arm icon, coloured with the admin accent.
//
// Rendered as an <img> of /brand-mark.svg rather than inline SVG: the mark
// is 93 paths, 79 KB, and inlined it was shipped in every HTML response and
// re-parsed on every load (Lighthouse flagged it as the deepest DOM subtree
// on the page). As a request it is fetched once and cached. The route reads
// the same accentColor the page's --primary comes from, so it still matches.
export function GraveklarMark({
  className,
  title = 'Graveklar',
}: {
  className?: string;
  title?: string;
}) {
  // Plain <img>: a static SVG, nothing for next/image to optimise.
  return <img src="/brand-mark.svg" alt={title} className={`object-contain ${className ?? ''}`} width={416} height={582} />;
}
