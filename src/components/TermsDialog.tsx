'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

interface TermsSection {
  title: string;
  content: string;
}

interface TermsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAccept: () => void;
  sections: TermsSection[];
  businessName: string;
  orgNumber?: string;
}

export default function TermsDialog({ open, onOpenChange, onAccept, sections, businessName, orgNumber }: TermsDialogProps) {
  const [reachedBottom, setReachedBottom] = useState(false);
  // A state-backed callback ref, not useRef: the dialog body is mounted by
  // Radix inside a portal, so on the render where `open` flips to true the
  // ref is still null. The effect below had `[open]` as its only dependency
  // and returned early on that null — nothing ever re-ran it once the node
  // existed, so neither the scroll listener nor the ResizeObserver was ever
  // attached and "Bla ned for å se godta-knappen" stayed up forever (Q-10).
  // Setting state from the ref callback re-runs the effect the moment the
  // element attaches.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  // Reset gate each time the dialog opens.
  useEffect(() => {
    if (open) setReachedBottom(false);
  }, [open]);

  // Scroll-position check. Previously used IntersectionObserver with
  // threshold:1.0 on a 4px sentinel — that combo is notoriously fragile
  // (sub-pixel rounding, scrollbar widths, padding all kept the observer
  // from ever reporting "100% visible" even when the user was at the
  // bottom). Falls back to a simple scrollTop + clientHeight comparison
  // with a generous 24px tolerance.
  useEffect(() => {
    if (!open) return;
    const root = scrollEl;
    if (!root) return;

    const check = () => {
      // If the content fits without scrolling (scrollHeight <= clientHeight),
      // there's nothing to scroll past — auto-unlock.
      const atBottom = root.scrollTop + root.clientHeight >= root.scrollHeight - 24;
      if (atBottom) setReachedBottom(true);
    };

    root.addEventListener('scroll', check, { passive: true });
    // Recheck when the layout settles (fonts load, content reflows).
    const ro = new ResizeObserver(check);
    ro.observe(root);
    // Initial check after layout — handles the "short content fits in view"
    // case where the user never scrolls at all.
    const raf = requestAnimationFrame(check);

    return () => {
      root.removeEventListener('scroll', check);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [open, scrollEl]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl flex flex-col max-h-[90vh]">
        <DialogHeader className="shrink-0">
          <DialogTitle className="text-lg">Leievilkår – {businessName}</DialogTitle>
          <DialogDescription>Les gjennom vilkårene helt til bunnen og klikk «Jeg godtar» for å fortsette</DialogDescription>
        </DialogHeader>

        <div ref={setScrollEl} className="overflow-y-auto flex-1 pr-1 custom-scrollbar space-y-5 text-sm" data-testid="terms-scroll">
          {sections.length === 0 && (
            <p className="text-muted-foreground py-8 text-center">Vilkår er ikke konfigurert ennå. Ta kontakt med utleier.</p>
          )}
          {sections.map((section, idx) => (
            <div key={idx}>
              <h3 className="font-semibold text-foreground mb-2">{idx + 1}. {section.title}</h3>
              <ul className="space-y-1 text-muted-foreground">
                {section.content.split('\n').filter(Boolean).map((item, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="shrink-0 text-muted-foreground/50 font-mono text-xs mt-0.5">{idx + 1}.{i + 1}</span>
                    <span className="leading-relaxed">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <p className="text-xs text-muted-foreground pt-2 border-t border-border">
            {businessName}{orgNumber ? ` · Org.nr ${orgNumber}` : ''}. Disse vilkårene er utarbeidet i samsvar med Forbrukertilsynets standardvilkår.
          </p>

          {/* Accept button at the bottom of the scrolled content. Physical
              placement substitutes for the previous JS-driven scroll gate:
              reaching this button requires scrolling through the terms.
              No flaky observers, no enforcement edge cases — the layout
              itself encourages the read-through. */}
          {sections.length > 0 && (
            <div className="pt-4 mt-4 border-t border-border">
              <Button
                onClick={onAccept}
                className="w-full bg-primary hover:bg-primary/90"
                size="lg"
              >
                <CheckCircle2 className="w-4 h-4 mr-2" />
                Jeg godtar vilkårene
              </Button>
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 flex-row gap-2 pt-4 border-t border-border mt-2 items-center">
          {/* Passive scroll hint — stretched along the footer next to the
              Lukk button. No jump button: the act of scrolling through is
              the read-through gate. */}
          {!reachedBottom && sections.length > 0 && (
            <p className="flex-1 inline-flex items-center justify-center gap-1.5 text-xs text-muted-foreground py-2">
              <ArrowDown className="w-3.5 h-3.5" />
              Bla ned for å se godta-knappen
            </p>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)} className="ml-auto">
            Lukk
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
