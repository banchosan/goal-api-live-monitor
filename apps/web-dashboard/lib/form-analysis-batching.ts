/**
 * Form history needs one GOAL request per unique team.  Keep this cap explicit
 * and shared by the UI and route: it protects against accidental unbounded
 * requests without rejecting the current expanded league scope.
 */
export const MAX_FORM_ANALYSIS_TEAMS = 500;

export function splitFormAnalysisBatches<T>(items: readonly T[], batchSize: number): T[][] {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('batchSize must be a positive integer');
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += batchSize) batches.push(items.slice(index, index + batchSize));
  return batches;
}
