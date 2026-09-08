// Fuel-needs calculator for the operator-facing checklist + booking detail.
//
// Rules (admin spec):
//   • Estimated usage = totalHours × consumptionPerHour (litres)
//   • Add a 10 L safety margin on top of estimated usage
//   • The machine arrives with a full tank — its capacity counts toward
//     coverage. So we only need to bring 20 L cans for what the tank can't
//     supply.
//   • If (estimated + margin) ≤ tank, no cans needed.
//   • Otherwise: cans = ceil((estimated + margin - tank) / 20)
//
// Example: 15 L usage, 28 L tank → 25 L needed ≤ 28 L → 0 cans.
// Example: 50 L usage, 28 L tank → 60 L needed > 28 L → ceil(32/20) = 2 cans.

export const FUEL_CAN_SIZE_L = 20;
export const FUEL_SAFETY_MARGIN_L = 10;

export interface FuelInputs {
  totalHours: number;
  tankLiters: number | null | undefined;
  consumptionPerHour: number | null | undefined;
}

export interface FuelNeeds {
  /** True if the machine has fuel specs configured so a calc is possible. */
  computable: boolean;
  /** Estimated litres consumed across the rental (raw, unrounded). */
  estimatedUsage: number;
  /** Machine tank capacity (litres). */
  tank: number;
  /** Margin litres added to the usage to handle longer-than-expected jobs. */
  margin: number;
  /** Litres still needed beyond what the full tank provides (clamped ≥ 0). */
  beyondTank: number;
  /** Number of 20 L cans the operator should bring (always rounded up). */
  cansNeeded: number;
  /** True total litres the operator should plan for (estimated + margin). */
  plannedTotal: number;
}

export function computeFuelNeeds(input: FuelInputs): FuelNeeds {
  const tank = Number(input.tankLiters) || 0;
  const cph = Number(input.consumptionPerHour) || 0;
  const hours = Math.max(0, input.totalHours);

  if (tank <= 0 || cph <= 0 || hours <= 0) {
    return {
      computable: false,
      estimatedUsage: 0, tank, margin: FUEL_SAFETY_MARGIN_L,
      beyondTank: 0, cansNeeded: 0, plannedTotal: 0,
    };
  }

  const estimatedUsage = hours * cph;
  const plannedTotal = estimatedUsage + FUEL_SAFETY_MARGIN_L;
  const beyondTank = Math.max(0, plannedTotal - tank);
  const cansNeeded = beyondTank > 0 ? Math.ceil(beyondTank / FUEL_CAN_SIZE_L) : 0;

  return {
    computable: true,
    estimatedUsage,
    tank,
    margin: FUEL_SAFETY_MARGIN_L,
    beyondTank,
    cansNeeded,
    plannedTotal,
  };
}

/** Pretty short label, e.g. "2 × 20 L kanner" / "Tank dekker turen". */
export function fuelCansLabel(needs: FuelNeeds): string {
  if (!needs.computable) return 'Drivstoff-data mangler';
  if (needs.cansNeeded === 0) return 'Tank dekker hele turen';
  return `${needs.cansNeeded} × ${FUEL_CAN_SIZE_L} L kanner`;
}
