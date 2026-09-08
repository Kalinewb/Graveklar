import { describe, it, expect } from 'vitest';
import { renderNoteTokens, parseNoteSegments, renderNote } from '@/lib/note-template';

describe('renderNoteTokens', () => {
  it('substitutes a token from the context', () => {
    expect(renderNoteTokens('inntil {{deliveryIncludedKm}} km', { deliveryIncludedKm: 40 }))
      .toBe('inntil 40 km');
  });

  it('accepts numbers and strings alike', () => {
    expect(renderNoteTokens('{{a}}/{{b}}', { a: 55, b: 'Bodø' })).toBe('55/Bodø');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(renderNoteTokens('{{  rate }}', { rate: 300 })).toBe('300');
  });

  it('marks an unknown token instead of throwing', () => {
    // A mistyped token in a marketing note must never 500 the front page.
    expect(renderNoteTokens('{{nope}}', {})).toBe('[mangler verdi: nope]');
  });

  it('treats an empty value as missing', () => {
    expect(renderNoteTokens('{{serviceArea}}', { serviceArea: '' }))
      .toBe('[mangler verdi: serviceArea]');
  });

  it('leaves text without tokens untouched', () => {
    expect(renderNoteTokens('ingen tokens her', { a: 1 })).toBe('ingen tokens her');
  });
});

describe('parseNoteSegments', () => {
  it('splits a bold run out of surrounding text', () => {
    expect(parseNoteSegments('a **b** c')).toEqual([
      { text: 'a ', bold: false },
      { text: 'b', bold: true },
      { text: ' c', bold: false },
    ]);
  });

  it('handles two bold runs', () => {
    expect(parseNoteSegments('**one** and **two**')).toEqual([
      { text: 'one', bold: true },
      { text: ' and ', bold: false },
      { text: 'two', bold: true },
    ]);
  });

  it('leaves an unclosed ** as literal text', () => {
    // A half-typed edit should look like a typo, not bold the rest of the card.
    expect(parseNoteSegments('a **b')).toEqual([{ text: 'a **b', bold: false }]);
  });

  it('drops an empty bold run rather than emitting an empty strong', () => {
    expect(parseNoteSegments('a****b')).toEqual([
      { text: 'a', bold: false },
      { text: 'b', bold: false },
    ]);
  });

  it('returns a single plain segment for plain text', () => {
    expect(parseNoteSegments('plain')).toEqual([{ text: 'plain', bold: false }]);
  });

  it('returns nothing for an empty string', () => {
    expect(parseNoteSegments('')).toEqual([]);
  });
});

describe('renderNote', () => {
  it('substitutes then splits, so a token can sit inside a bold run', () => {
    expect(renderNote('**{{n}} km** inkludert', { n: 40 })).toEqual([
      { text: '40 km', bold: true },
      { text: ' inkludert', bold: false },
    ]);
  });

  it('renders the shipped pricing note against real settings', () => {
    const out = renderNote(
      '**Hva er inkludert?** levering og henting (inntil {{deliveryIncludedKm}} km). Ekstra timer {{preOrderHourRate}} kr per time.',
      { deliveryIncludedKm: 40, preOrderHourRate: 300 }
    );
    expect(out.map((s) => s.text).join('')).toBe(
      'Hva er inkludert? levering og henting (inntil 40 km). Ekstra timer 300 kr per time.'
    );
    expect(out[0]).toEqual({ text: 'Hva er inkludert?', bold: true });
  });
});
