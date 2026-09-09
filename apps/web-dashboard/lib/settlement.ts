export type SettlementOutcome = 'WIN' | 'LOSS' | 'PUSH' | 'HALF_WIN' | 'HALF_LOSS' | 'VOID';

export type Settlement = { outcome: SettlementOutcome; profitUnits: number };

function splitQuarterLine(line: number) {
  const lower = Math.floor(line * 2) / 2;
  const upper = Math.ceil(line * 2) / 2;
  return Math.abs(lower - upper) < Number.EPSILON ? [line] : [lower, upper];
}

function settleBinary(value: number, odds: number): Settlement {
  if (value > 0) return { outcome: 'WIN', profitUnits: odds - 1 };
  if (value < 0) return { outcome: 'LOSS', profitUnits: -1 };
  return { outcome: 'PUSH', profitUnits: 0 };
}

function combine(parts: Settlement[]): Settlement {
  const profitUnits = parts.reduce((sum, part) => sum + part.profitUnits, 0) / parts.length;
  if (parts.every((part) => part.outcome === 'WIN')) return { outcome: 'WIN', profitUnits };
  if (parts.every((part) => part.outcome === 'LOSS')) return { outcome: 'LOSS', profitUnits };
  if (parts.every((part) => part.outcome === 'PUSH')) return { outcome: 'PUSH', profitUnits };
  if (parts.some((part) => part.outcome === 'WIN')) return { outcome: 'HALF_WIN', profitUnits };
  if (parts.some((part) => part.outcome === 'LOSS')) return { outcome: 'HALF_LOSS', profitUnits };
  return { outcome: 'PUSH', profitUnits };
}

/** Settles a home/away Asian Handicap. `side` is the selected side's final score. */
export function settleAsianHandicap(selectedScore: number, opponentScore: number, line: number, odds: number): Settlement {
  return combine(splitQuarterLine(line).map((part) => settleBinary(selectedScore + part - opponentScore, odds)));
}

/** Settles total-goals Over or Under, including quarter lines. */
export function settleTotalGoals(totalGoals: number, side: 'OVER' | 'UNDER', line: number, odds: number): Settlement {
  return combine(splitQuarterLine(line).map((part) => settleBinary(side === 'OVER' ? totalGoals - part : part - totalGoals, odds)));
}

export function settleMoneyline(selectedScore: number, opponentScore: number, odds: number): Settlement {
  return settleBinary(selectedScore - opponentScore, odds);
}
