import type { AwakeHours } from '@/engine/types';

export type { AwakeHours };

// The Path Optimizer's awake-hours scheduler asks "is the player awake at T?" hundreds of times per
// target. lib/events' getTimezoneOffsetAt builds a new Intl.DateTimeFormat on every call, which made
// that ~45 ms per target; this keeps one formatter per timezone and caches offsets per 15 minutes
// (DST changes fall on whole or half hours). Same arithmetic as getTimezoneOffsetAt /
// getLocalTimestampInTimezone, so results are identical.
const formatters = new Map<string, Intl.DateTimeFormat>();
const offsetCache = new Map<string, number>();
const OFFSET_BUCKET_SECONDS = 900;
const MAX_CACHED_OFFSETS = 200_000;

export function timezoneOffsetAt(timezone: string, timestampSeconds: number): number {
  const key = `${timezone}|${Math.floor(timestampSeconds / OFFSET_BUCKET_SECONDS)}`;
  const cached = offsetCache.get(key);
  if (cached !== undefined) return cached;

  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false,
    });
    formatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(new Date(timestampSeconds * 1000));
  const get = (type: string) => parseInt(parts.find(p => p.type === type)!.value);
  const wallClockUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  // Whole-second wall clock against the same second's instant — the offset itself, never a fraction.
  const offset = Math.round((wallClockUTC - Math.floor(timestampSeconds) * 1000) / 1000);

  if (offsetCache.size >= MAX_CACHED_OFFSETS) offsetCache.clear();
  offsetCache.set(key, offset);
  return offset;
}

function localTimestamp(dateStr: string, hhmm: string, timezone: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  const guessUTC = Date.UTC(y, m - 1, d, h, min, 0);
  return Math.floor((guessUTC - timezoneOffsetAt(timezone, Math.floor(guessUTC / 1000)) * 1000) / 1000);
}

function parseHHMM(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function isAwake(timestampSeconds: number, hours: AwakeHours): boolean {
  const start = parseHHMM(hours.start);
  const end = parseHHMM(hours.end);
  if (start === end) return true; // A zero-width window is treated as "always awake".

  // The offset is taken at a whole second, so a fractional timestamp just after a minute boundary
  // (e.g. 08:00:00.5) still reads as that minute.
  const local = timestampSeconds + timezoneOffsetAt(hours.timezone, Math.floor(timestampSeconds));
  const minuteOfDay = Math.floor((((local % 86400) + 86400) % 86400) / 60);
  return start < end
    ? minuteOfDay >= start && minuteOfDay < end
    : minuteOfDay >= start || minuteOfDay < end;
}

// `HH:MM` on the local calendar day `dayOffset` days after the one containing `timestampSeconds`.
// Done on calendar dates rather than by adding seconds (as lib/events' getNextTimeInTimezone does,
// which skips a day for late-evening targets) so it is exact across DST changes and late hours.
function atLocalTime(timestampSeconds: number, hhmm: string, timezone: string, dayOffset: number): number {
  const local = new Date((timestampSeconds + timezoneOffsetAt(timezone, Math.floor(timestampSeconds))) * 1000);
  const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dayOffset));
  return localTimestamp(day.toISOString().slice(0, 10), hhmm, timezone);
}

/**
 * The earliest instant at or after `timestampSeconds` that falls inside the awake window — the
 * timestamp itself if the player is already awake then, else the next wake-up time.
 */
export function nextAwakeTime(timestampSeconds: number, hours: AwakeHours | null): number {
  if (!hours || isAwake(timestampSeconds, hours)) return timestampSeconds;
  const today = atLocalTime(timestampSeconds, hours.start, hours.timezone, 0);
  return today > timestampSeconds ? today : atLocalTime(timestampSeconds, hours.start, hours.timezone, 1);
}

/**
 * The latest instant at or before `timestampSeconds` that falls inside the awake window — the
 * timestamp itself if the player is awake then, else one minute before the most recent bedtime.
 */
export function lastAwakeTime(timestampSeconds: number, hours: AwakeHours | null): number {
  if (!hours || isAwake(timestampSeconds, hours)) return timestampSeconds;
  const today = atLocalTime(timestampSeconds, hours.end, hours.timezone, 0);
  const bedtime = today <= timestampSeconds ? today : atLocalTime(timestampSeconds, hours.end, hours.timezone, -1);
  return bedtime - 60;
}
