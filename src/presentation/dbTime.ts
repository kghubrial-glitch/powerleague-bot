/**
 * Parses a timestamp stored by SQLite (`YYYY-MM-DD HH:MM:SS`, UTC) or a JS ISO
 * string. SQLite's format has a space instead of `T` and no timezone marker, so
 * it must be normalized before `new Date()` treats it as local time.
 */
export function parseDbTimestamp(ts: string): number {
  if (!ts) return Number.NaN;
  const normalized = ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`;
  return new Date(normalized).getTime();
}