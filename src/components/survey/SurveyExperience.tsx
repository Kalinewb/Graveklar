'use client';

import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { ArrowRight, ArrowLeft, Check, Loader2 } from 'lucide-react';
import { GraveklarMark } from '@/components/GraveklarMark';

export type SurveyQuestion = {
  key: string;
  type: 'intro' | 'radio' | 'check' | 'likert' | 'range' | 'text' | 'email' | 'price-callout';
  section: string;
  label: string;
  hint: string | null;
  options: string[];
  config: Record<string, unknown>;
  required: boolean;
};

type Step = { section: string; questions: SurveyQuestion[] };

/** A question that stops "Neste", and why. `consent` is the optional-e-mail
 *  case: the question itself is answered, the consent box beside it is not. */
type Blocking = { key: string; label: string; reason: 'missing' | 'consent' };

const CONSENT_KEY = 'samtykke';
const ANSWERABLE = new Set(['radio', 'check', 'likert', 'range', 'text', 'email']);

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function SurveyExperience({
  questions,
  leadPercent,
  businessName,
  privacyHref = '/personvern',
}: {
  questions: SurveyQuestion[];
  /** Fallback discount % shown on the thank-you screen if the server doesn't echo one. */
  leadPercent: number;
  businessName: string;
  privacyHref?: string;
}) {
  // Group consecutive questions into wizard steps by section.
  const steps = useMemo<Step[]>(() => {
    const out: Step[] = [];
    for (const q of questions) {
      const last = out[out.length - 1];
      if (last && last.section === q.section) last.questions.push(q);
      else out.push({ section: q.section, questions: [q] });
    }
    return out;
  }, [questions]);

  const [stepIdx, setStepIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [touchedRanges, setTouchedRanges] = useState<Set<string>>(new Set());
  // Which questions are holding the step back, not just "something is".
  // "Vennligst svar på spørsmålene før du går videre." with no marker anywhere
  // made a five-question step a hunt, and on the last step — where the e-mail
  // is explicitly optional and the real blocker is an unticked consent box —
  // it pointed at no visible required question at all (Q-15).
  const [blocking, setBlocking] = useState<Blocking[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ code: string | null; percent: number } | null>(null);

  const isIntroStep = (s: Step) => s.questions.length === 1 && s.questions[0].type === 'intro';
  const totalSteps = steps.length;

  // Scroll to the top whenever the step changes or the thank-you screen
  // appears. Runs AFTER the new content renders, so it lands reliably (an
  // inline scroll in next()/prev() fires before the layout updates).
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [stepIdx, done]);

  const emailQuestion = useMemo(() => questions.find((q) => q.type === 'email'), [questions]);

  function setAnswer(key: string, value: unknown) {
    setAnswers((prev) => ({ ...prev, [key]: value }));
    setBlocking([]);
  }

  /** Every question in the step that stops "Neste", in the order they appear. */
  function blockingQuestions(s: Step): Blocking[] {
    const out: Blocking[] = [];
    for (const q of s.questions) {
      if (!ANSWERABLE.has(q.type)) continue;
      const v = answers[q.key];
      if (q.type === 'email') {
        // Email is optional; but if an address is typed and consent is
        // required, the consent box must be checked to continue.
        const email = typeof v === 'string' ? v.trim() : '';
        const consentRequired = q.config?.consentRequired === true;
        if (email && consentRequired && answers[CONSENT_KEY] !== true) {
          out.push({ key: q.key, label: q.label, reason: 'consent' });
        }
        continue;
      }
      if (!q.required) continue;
      const missing =
        q.type === 'check'
          ? !Array.isArray(v) || v.length === 0
          : q.type === 'range'
            ? !touchedRanges.has(q.key)
            : v === undefined || v === null || v === '';
      if (missing) out.push({ key: q.key, label: q.label, reason: 'missing' });
    }
    return out;
  }

  async function submit() {
    setSubmitting(true);
    let payload: { ok?: boolean; discountCode?: string | null; discountPercent?: number } = {};
    try {
      const res = await fetch('/api/survey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(answers),
      });
      payload = await res.json().catch(() => ({}));
    } catch {
      // Network errors shouldn't block the thank-you screen.
    }
    setDone({ code: payload.discountCode ?? null, percent: payload.discountPercent ?? leadPercent });
    setSubmitting(false);
  }

  function next() {
    const s = steps[stepIdx];
    if (!isIntroStep(s)) {
      const stuck = blockingQuestions(s);
      if (stuck.length > 0) {
        setBlocking(stuck);
        // Put the first offender on screen — on a five-question step the
        // marker is otherwise below the fold next to the button they pressed.
        document.getElementById(`sq-block-${stuck[0].key}`)
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
    }
    if (stepIdx >= totalSteps - 1) {
      submit();
      return;
    }
    setStepIdx((i) => i + 1);
    setBlocking([]);
  }

  function prev() {
    if (stepIdx > 0) {
      setStepIdx((i) => i - 1);
      setBlocking([]);
    }
  }

  const progressPct = totalSteps > 1 ? Math.round((stepIdx / (totalSteps - 1)) * 100) : 0;
  const current = steps[stepIdx];
  const intro = current && isIntroStep(current);
  const isLast = stepIdx >= totalSteps - 1;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-2xl px-4 pb-24">
        {/* Brand bar */}
        <header className="flex items-center gap-3 pt-7 pb-3">
          <GraveklarMark className="h-12 w-12 shrink-0" />
          <div className="leading-tight">
            <div className="text-lg font-bold tracking-tight">{businessName}</div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Behovsundersøkelse</div>
          </div>
        </header>

        {/* Progress */}
        {!done && (
          <div className="mb-1">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
                style={{ width: `${done ? 100 : progressPct}%` }}
              />
            </div>
            {!intro && (
              <div className="mt-1.5 text-right text-[11px] tracking-wide text-muted-foreground">
                Steg {stepIdx} av {totalSteps - 1}
              </div>
            )}
          </div>
        )}

        {done ? (
          <ThankYou businessName={businessName} code={done.code} percent={done.percent} />
        ) : (
          <div
            key={stepIdx}
            className="mt-4 rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8 animate-in fade-in slide-in-from-bottom-2 duration-300"
          >
            {intro ? (
              <IntroBlock q={current.questions[0]} />
            ) : (
              <>
                <div className="mb-5 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
                  {current.section}
                </div>
                <div className="space-y-7">
                  {current.questions.map((q) => {
                    const stuck = blocking.find((b) => b.key === q.key) ?? null;
                    return (
                      <div
                        key={q.key}
                        id={`sq-block-${q.key}`}
                        className={cn(
                          'scroll-mt-24',
                          stuck && 'rounded-xl border border-destructive/50 bg-destructive/5 p-4',
                        )}
                      >
                        <QuestionField
                          q={q}
                          value={answers[q.key]}
                          consent={answers[CONSENT_KEY] === true}
                          touched={touchedRanges.has(q.key)}
                          blocked={stuck?.reason ?? null}
                          onChange={(v) => setAnswer(q.key, v)}
                          onConsent={(c) => setAnswer(CONSENT_KEY, c)}
                          onRangeTouch={() =>
                            setTouchedRanges((prev) => new Set(prev).add(q.key))
                          }
                        />
                      </div>
                    );
                  })}
                </div>
                {blocking.length > 0 && (
                  <div className="mt-5 space-y-1 text-sm font-medium text-destructive">
                    {(() => {
                      const missing = blocking.filter((b) => b.reason === 'missing');
                      const consent = blocking.find((b) => b.reason === 'consent');
                      return (
                        <>
                          {missing.length > 0 && (
                            <p>
                              {missing.length === 1
                                ? `Mangler svar: «${missing[0].label}».`
                                : `Mangler svar: ${missing.map((m) => `«${m.label}»`).join(', ')}.`}
                            </p>
                          )}
                          {consent && (
                            <p>Kryss av for samtykke for å legge igjen e-postadressen – eller la feltet stå tomt.</p>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
              </>
            )}

            {/* Nav */}
            <div className="mt-8 flex gap-3">
              {stepIdx > 0 && !intro && (
                <button
                  type="button"
                  onClick={prev}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-border px-4 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
                >
                  <ArrowLeft className="h-4 w-4" /> Tilbake
                </button>
              )}
              <button
                type="button"
                onClick={next}
                disabled={submitting}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-sm transition-all hover:bg-primary/90 disabled:opacity-60"
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Sender …
                  </>
                ) : intro ? (
                  <>Start <ArrowRight className="h-4 w-4" /></>
                ) : isLast ? (
                  'Send inn'
                ) : (
                  <>Neste <ArrowRight className="h-4 w-4" /></>
                )}
              </button>
            </div>
          </div>
        )}

        <p className="mt-6 text-center text-[11px] leading-relaxed text-muted-foreground">
          Svarene er anonyme med mindre du legger igjen e-post. Ca. 2 minutter.{' '}
          <a href={privacyHref} className="underline hover:text-foreground">Personvern</a>
        </p>
      </div>
    </div>
  );
}

function IntroBlock({ q }: { q: SurveyQuestion }) {
  return (
    <div>
      <div className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-[11px] font-semibold text-muted-foreground">
        ⏱ 2 minutter · anonymt
      </div>
      <h1 className="text-2xl font-bold leading-tight tracking-tight sm:text-3xl">{q.label}</h1>
      {q.hint && <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">{q.hint}</p>}
    </div>
  );
}

function QuestionField({
  q,
  value,
  consent,
  touched,
  blocked,
  onChange,
  onConsent,
  onRangeTouch,
}: {
  q: SurveyQuestion;
  value: unknown;
  consent: boolean;
  touched: boolean;
  /** Set when this question is what stopped "Neste" — see Blocking. */
  blocked: 'missing' | 'consent' | null;
  onChange: (v: unknown) => void;
  onConsent: (c: boolean) => void;
  onRangeTouch: () => void;
}) {
  if (q.type === 'price-callout') {
    return (
      <div className="rounded-xl bg-primary px-5 py-4 text-primary-foreground">
        <div className="text-sm font-semibold">{q.label}</div>
        {q.hint && <div className="mt-1 text-sm leading-relaxed text-primary-foreground/90">{q.hint}</div>}
      </div>
    );
  }

  const inputId = `sq-${q.key}`;
  const labelBlock = (
    <div>
      <label htmlFor={inputId} className={cn('block text-[15px] font-semibold leading-snug', blocked && 'text-destructive')}>
        {q.label}
        {/* Real text, not just a colour: a screen reader and a colour-blind
            respondent both have to be able to find the offending question. */}
        {blocked && (
          <span className="ml-2 align-middle rounded-full border border-destructive/50 px-2 py-0.5 text-[11px] font-semibold tracking-wide">
            {blocked === 'consent' ? 'Mangler samtykke' : 'Mangler svar'}
          </span>
        )}
      </label>
      {q.hint && <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{q.hint}</p>}
    </div>
  );

  if (q.type === 'radio') {
    return (
      <div>
        {labelBlock}
        <div className="mt-3 space-y-2">
          {q.options.map((opt) => {
            const sel = value === opt;
            return (
              <OptionCard key={opt} selected={sel} onClick={() => onChange(opt)}>
                <span className={cn('h-4 w-4 shrink-0 rounded-full border-2', sel ? 'border-primary bg-primary' : 'border-muted-foreground/40')} />
                <span>{opt}</span>
              </OptionCard>
            );
          })}
        </div>
      </div>
    );
  }

  if (q.type === 'check') {
    const arr = Array.isArray(value) ? (value as string[]) : [];
    const max = q.config?.max != null ? num(q.config.max, 99) : 99;
    const toggle = (opt: string) => {
      if (arr.includes(opt)) onChange(arr.filter((x) => x !== opt));
      else {
        const next = arr.length >= max ? [...arr.slice(1), opt] : [...arr, opt];
        onChange(next);
      }
    };
    return (
      <div>
        {labelBlock}
        <div className="mt-3 space-y-2">
          {q.options.map((opt) => {
            const sel = arr.includes(opt);
            return (
              <OptionCard key={opt} selected={sel} onClick={() => toggle(opt)}>
                <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border-2', sel ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40')}>
                  {sel && <Check className="h-3 w-3" />}
                </span>
                <span>{opt}</span>
              </OptionCard>
            );
          })}
        </div>
      </div>
    );
  }

  if (q.type === 'likert') {
    return (
      <div>
        {labelBlock}
        <div className="mt-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${q.options.length}, minmax(0, 1fr))` }}>
          {q.options.map((opt) => {
            const sel = value === opt;
            return (
              <button
                key={opt}
                type="button"
                onClick={() => onChange(opt)}
                className={cn(
                  'rounded-xl border px-2 py-3 text-center text-[13px] font-medium leading-tight transition-all',
                  sel ? 'border-primary bg-primary/10 text-foreground shadow-[inset_0_0_0_1px] shadow-primary' : 'border-border bg-card hover:border-primary/50'
                )}
              >
                {opt}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (q.type === 'range') {
    const min = num(q.config?.min, 0);
    const max = num(q.config?.max, 100);
    const step = num(q.config?.step, 1);
    const unit = typeof q.config?.unit === 'string' ? q.config.unit : '';
    const mid = Math.round((min + max) / 2 / step) * step;
    const display = touched ? num(value, mid) : mid;
    return (
      <div>
        {labelBlock}
        <div className="mt-4 text-center">
          {touched ? (
            <div className="text-3xl font-bold tabular-nums text-primary">
              {num(value, mid).toLocaleString('nb-NO')} <span className="text-base font-medium text-muted-foreground">{unit}</span>
            </div>
          ) : (
            // The thumb starts at the midpoint, which reads as an answer
            // already given — so the "not answered yet" state has to be
            // spelled out rather than implied (Q-15).
            <div className={cn('text-sm font-medium', blocked ? 'text-destructive' : 'text-muted-foreground')}>
              Ikke besvart – dra i skalaen
            </div>
          )}
        </div>
        <input
          id={inputId}
          type="range"
          min={min}
          max={max}
          step={step}
          value={display}
          aria-invalid={blocked ? true : undefined}
          onChange={(e) => { onRangeTouch(); onChange(Number(e.target.value)); }}
          // A range input fires no change event when the thumb is already
          // where the respondent wants it, so someone whose answer *is* the
          // midpoint could never satisfy the `touchedRanges` gate — they had
          // to drag away and back (Q-15). Any deliberate interaction now
          // counts, and commits the value currently on screen.
          onPointerUp={() => { if (!touched) { onRangeTouch(); onChange(num(value, mid)); } }}
          onKeyDown={() => { if (!touched) { onRangeTouch(); onChange(num(value, mid)); } }}
          className={cn('mt-3 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary', !touched && 'opacity-60')}
        />
        <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground tabular-nums">
          <span>{min.toLocaleString('nb-NO')} {unit}</span>
          <span>{max.toLocaleString('nb-NO')} {unit}+</span>
        </div>
      </div>
    );
  }

  if (q.type === 'text') {
    const placeholder = typeof q.config?.placeholder === 'string' ? q.config.placeholder : '';
    const maxLength = q.config?.maxLength != null ? num(q.config.maxLength, undefined as unknown as number) : undefined;
    const inputMode = typeof q.config?.inputMode === 'string' ? (q.config.inputMode as 'numeric' | 'text') : undefined;
    const single = maxLength != null || inputMode != null;
    return (
      <div>
        {labelBlock}
        {single ? (
          <input
            id={inputId}
            type="text"
            inputMode={inputMode}
            maxLength={maxLength}
            placeholder={placeholder}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            className="mt-3 w-full rounded-xl border border-border bg-card px-4 py-3 text-[15px] outline-none focus:border-primary"
          />
        ) : (
          <textarea
            id={inputId}
            placeholder={placeholder}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            className="mt-3 min-h-[88px] w-full resize-y rounded-xl border border-border bg-card px-4 py-3 text-[15px] outline-none focus:border-primary"
          />
        )}
      </div>
    );
  }

  if (q.type === 'email') {
    const email = typeof value === 'string' ? value : '';
    const consentRequired = q.config?.consentRequired === true;
    const consentLabel = typeof q.config?.consentLabel === 'string' ? q.config.consentLabel : 'Jeg samtykker til å bli kontaktet.';
    return (
      <div>
        {labelBlock}
        <input
          id={inputId}
          type="email"
          placeholder="din@epost.no"
          value={email}
          onChange={(e) => onChange(e.target.value)}
          className="mt-3 w-full rounded-xl border border-border bg-card px-4 py-3 text-[15px] outline-none focus:border-primary"
        />
        {consentRequired && email.trim() && (
          <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-xl border border-border bg-muted/40 p-3 text-[13px] leading-relaxed">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => onConsent(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
            />
            <span>{consentLabel}</span>
          </label>
        )}
      </div>
    );
  }

  return null;
}

function OptionCard({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left text-[15px] transition-all',
        selected ? 'border-primary bg-primary/5 shadow-[inset_0_0_0_1px] shadow-primary' : 'border-border bg-card hover:border-primary/50 hover:bg-muted/30'
      )}
    >
      {children}
    </button>
  );
}

function ThankYou({ businessName, code, percent }: { businessName: string; code: string | null; percent: number }) {
  return (
    <div className="mt-4 rounded-2xl border border-border bg-card p-8 text-center shadow-sm animate-in fade-in zoom-in-95 duration-300">
      <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-primary">
        <Check className="h-8 w-8 text-primary-foreground" strokeWidth={3} />
      </div>
      <h1 className="text-2xl font-bold tracking-tight">Tusen takk!</h1>
      <p className="mx-auto mt-2 max-w-sm text-[15px] leading-relaxed text-muted-foreground">
        Svaret ditt hjelper oss å bygge riktig tilbud for {businessName}.
      </p>
      {code && (
        <div className="mx-auto mt-6 max-w-sm rounded-xl border border-primary/30 bg-primary/5 p-5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Din rabattkode – {percent} % ved lansering
          </div>
          <div className="mt-2 select-all font-mono text-2xl font-bold tracking-wider text-primary">{code}</div>
          <div className="mt-2 text-[13px] text-muted-foreground">
            Vi har også sendt koden til e-posten din. Bruk den når vi åpner for booking.
          </div>
        </div>
      )}
      <p className="mt-6 text-[13px] text-muted-foreground">Du kan lukke siden nå.</p>
    </div>
  );
}
