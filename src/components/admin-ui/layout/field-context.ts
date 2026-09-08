'use client';

import { createContext, useContext } from 'react';

// Ids minted by the nearest FieldRow so the control inside it can wire itself
// to the row label: single-input controls put `controlId` on their input
// (label click focuses it, screen readers read the label as its name);
// multi-button controls expose `role="group" aria-labelledby={labelId}`.

export interface FieldIds {
  controlId: string;
  labelId: string;
}

export const FieldContext = createContext<FieldIds | null>(null);

export function useFieldIds(): FieldIds | null {
  return useContext(FieldContext);
}
