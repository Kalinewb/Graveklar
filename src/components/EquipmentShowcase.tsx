'use client';

import { useCallback, useEffect } from 'react';
import useEmblaCarousel from 'embla-carousel-react';
import { CheckCircle2, ChevronLeft, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { FramedEquipmentImage, type EquipmentImageEffects } from '@/lib/equipment-bg';
import { formatMachineLabel } from '@/lib/machine-display';

interface ShowcaseMachine {
  id: string;
  name: string;
  model: string;
  year?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  specs?: string | null;
  features?: string | null;
  included?: string | null;
  dayPrice?: number | null;
  weekendPrice?: number | null;
  weekPrice?: number | null;
  photoScale?: number | null;
}

interface Props {
  machines: ShowcaseMachine[];
  selectedMachineId: string;
  onSelect: (id: string) => void;
  effects: EquipmentImageEffects;
  popularMachineId: string;
  showMostPopular: boolean;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export default function EquipmentShowcase({
  machines,
  selectedMachineId,
  onSelect,
  effects,
  popularMachineId,
  showMostPopular,
}: Props) {
  const eqIdx = machines.findIndex((m) => m.id === selectedMachineId);
  const activeIdx = eqIdx >= 0 ? eqIdx : 0;

  const [emblaRef, emblaApi] = useEmblaCarousel({
    loop: false,
    align: 'start',
    skipSnaps: false,
  });

  // Sync external selection → embla position.
  useEffect(() => {
    if (!emblaApi) return;
    if (emblaApi.selectedScrollSnap() !== activeIdx) {
      emblaApi.scrollTo(activeIdx, true);
    }
  }, [emblaApi, activeIdx]);

  // Sync embla swipe → external selection.
  useEffect(() => {
    if (!emblaApi) return;
    const onSelectFn = () => {
      const idx = emblaApi.selectedScrollSnap();
      const target = machines[idx];
      if (target && target.id !== selectedMachineId) onSelect(target.id);
    };
    emblaApi.on('select', onSelectFn);
    return () => { emblaApi.off('select', onSelectFn); };
  }, [emblaApi, machines, selectedMachineId, onSelect]);

  const scrollPrev = useCallback(() => emblaApi?.scrollPrev(), [emblaApi]);
  const scrollNext = useCallback(() => emblaApi?.scrollNext(), [emblaApi]);

  return (
    <div>
      {/* Tab-style navigation (clickable) */}
      <div className="flex justify-center gap-2 mb-8 flex-wrap">
        {machines.map((eq, i) => (
          <button
            key={eq.id}
            onClick={() => onSelect(eq.id)}
            type="button"
            className={`px-4 py-2 rounded-full text-sm font-medium border-2 transition-colors ${
              i === activeIdx ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:border-primary/50'
            }`}
          >
            {formatMachineLabel({ name: eq.name, model: eq.model })}
          </button>
        ))}
      </div>

      {/* Embla viewport */}
      <div className="relative">
        <div ref={emblaRef} className="overflow-hidden">
          <div className="flex">
            {machines.map((m) => {
              const mSpecs = parseJson<{ label: string; value: string }[]>(m.specs, []);
              const mFeatures = parseJson<{ title: string; desc: string }[]>(m.features, []);
              const mIncluded = parseJson<string[]>(m.included, []);
              const isPopular = showMostPopular && popularMachineId === m.id;
              return (
                <div key={m.id} className="flex-[0_0_100%] min-w-0 px-1">
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-start">
                    <div className="relative">
                      {m.imageUrl && (
                        <div className="relative">
                          <FramedEquipmentImage
                            src={m.imageUrl}
                            alt={m.name}
                            effects={effects}
                            photoScale={m.photoScale ?? null}
                            containerClassName="w-full aspect-[6/5]"
                          />
                          {isPopular && (
                            <div className="absolute top-3 left-3 z-20">
                              <Badge className="bg-primary text-primary-foreground">Mest populær</Badge>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <div>
                      <h3 className="text-2xl font-bold mb-2">
                        {formatMachineLabel({ name: m.name, model: m.model, year: m.year })}
                      </h3>
                      {m.description && <p className="text-muted-foreground leading-relaxed mb-6">{m.description}</p>}
                      {mSpecs.length > 0 && (
                        <div className="grid grid-cols-2 gap-3 mb-6">
                          {mSpecs.map((s) => (
                            <div key={s.label} className="p-3 rounded-lg bg-muted/50">
                              <div className="text-xs text-muted-foreground uppercase tracking-wider">{s.label}</div>
                              <div className="text-sm font-medium mt-0.5">{s.value}</div>
                            </div>
                          ))}
                        </div>
                      )}
                      {mIncluded.length > 0 && (
                        <div className="mb-4">
                          <div className="text-sm font-semibold mb-2">Inkludert</div>
                          <div className="space-y-1">
                            {mIncluded.map((item, i) => (
                              <div key={i} className="flex items-center gap-2 text-sm text-muted-foreground">
                                <CheckCircle2 className="w-3.5 h-3.5 text-primary shrink-0" />{item}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {mFeatures.length > 0 && (
                        <div>
                          <div className="text-sm font-semibold mb-2">Egenskaper</div>
                          <div className="space-y-1">
                            {mFeatures.map((f, i) => (
                              <div key={i} className="text-sm"><span className="font-medium">{f.title}:</span> <span className="text-muted-foreground">{f.desc}</span></div>
                            ))}
                          </div>
                        </div>
                      )}
                      {(m.dayPrice != null || m.weekendPrice != null || m.weekPrice != null) && (
                        <div className="mt-6 flex flex-wrap gap-3">
                          {m.dayPrice != null && <Badge variant="secondary">Dag: {m.dayPrice.toLocaleString('nb-NO')} kr</Badge>}
                          {m.weekendPrice != null && <Badge variant="secondary">Helg: {m.weekendPrice.toLocaleString('nb-NO')} kr</Badge>}
                          {m.weekPrice != null && <Badge variant="secondary">Uke: {m.weekPrice.toLocaleString('nb-NO')} kr</Badge>}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Prev/next buttons (also clickable for accessibility) */}
        {machines.length > 1 && (
          <>
            <button
              type="button"
              onClick={scrollPrev}
              aria-label="Forrige utstyr"
              className="hidden md:flex absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-background/90 border border-border items-center justify-center shadow hover:bg-background"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={scrollNext}
              aria-label="Neste utstyr"
              className="hidden md:flex absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-background/90 border border-border items-center justify-center shadow hover:bg-background"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </>
        )}
      </div>

      <p className="text-xs text-muted-foreground text-center mt-4 md:hidden">
        ← Sveip for å se mer utstyr →
      </p>
    </div>
  );
}
