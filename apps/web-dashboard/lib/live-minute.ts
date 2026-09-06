export function displayMatchMinute(status: string | null | undefined) {
  const value = String(status ?? '');
  if (/^\d+(?:\+\d+)?$/.test(value)) return `${value}'`;
  if (['HT', 'HALF_TIME', 'HALF TIME'].includes(value.toUpperCase())) return 'HT';
  if (['FT', 'FINISHED', 'AFTER_ET', 'AFTER_PEN'].includes(value.toUpperCase())) return 'FT';
  return "--'（Socket分数待ち）";
}
