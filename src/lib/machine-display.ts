/** Display label for a machine row — avoids repeating name when model duplicates it. */
export function formatMachineLabel(machine: {
  name: string;
  model?: string | null;
  year?: number | string | null;
}): string {
  const parts: string[] = [machine.name];
  const model = machine.model?.trim();
  const name = machine.name.trim();
  // Skip the model when the name already carries it — equal outright
  // ("Rippa" / "Rippa"), or contained as a whole word, which is how
  // "Bobcat Z27" + model "Z27" used to render as "Bobcat Z27 Z27".
  const nameAlreadyHasModel = !!model && (
    model.toLowerCase() === name.toLowerCase() ||
    new RegExp(`(^|\\s)${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\s)`, 'i').test(name)
  );
  if (model && !nameAlreadyHasModel) {
    parts.push(model);
  }
  if (machine.year != null && String(machine.year).trim()) {
    parts.push(String(machine.year));
  }
  return parts.join(' · ');
}
