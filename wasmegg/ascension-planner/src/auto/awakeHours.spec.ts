import { describe, expect, test } from 'vitest';
import { isAwake, lastAwakeTime, nextAwakeTime, timezoneOffsetAt, type AwakeHours } from './awakeHours';
import { getTimezoneOffsetAt } from '@/lib/events';

const UTC_DAY: AwakeHours = { start: '08:00', end: '23:00', timezone: 'UTC' };
const at = (iso: string) => Date.parse(iso) / 1000;

describe('awake hours', () => {
  test('inside the window is unchanged', () => {
    expect(nextAwakeTime(at('2026-10-21T12:00:00Z'), UTC_DAY)).toBe(at('2026-10-21T12:00:00Z'));
  });

  test('after bedtime rolls to the next morning', () => {
    expect(nextAwakeTime(at('2026-10-21T23:30:00Z'), UTC_DAY)).toBe(at('2026-10-22T08:00:00Z'));
  });

  test('before waking rolls to the same morning', () => {
    expect(nextAwakeTime(at('2026-10-21T03:00:00Z'), UTC_DAY)).toBe(at('2026-10-21T08:00:00Z'));
  });

  test('window wrapping past midnight', () => {
    const night: AwakeHours = { start: '14:00', end: '02:00', timezone: 'UTC' };
    expect(isAwake(at('2026-10-21T01:00:00Z'), night)).toBe(true);
    expect(isAwake(at('2026-10-21T10:00:00Z'), night)).toBe(false);
    expect(nextAwakeTime(at('2026-10-21T10:00:00Z'), night)).toBe(at('2026-10-21T14:00:00Z'));
  });

  test('respects the timezone', () => {
    const ny: AwakeHours = { start: '08:00', end: '23:00', timezone: 'America/New_York' };
    // 05:00 UTC = 01:00 EDT -> wake at 08:00 EDT = 12:00 UTC
    expect(nextAwakeTime(at('2026-10-21T05:00:00Z'), ny)).toBe(at('2026-10-21T12:00:00Z'));
  });

  test('last awake moment before a sleeping time is just before bedtime', () => {
    expect(lastAwakeTime(at('2026-10-22T03:00:00Z'), UTC_DAY)).toBe(at('2026-10-21T22:59:00Z'));
    expect(lastAwakeTime(at('2026-10-21T07:00:00Z'), UTC_DAY)).toBe(at('2026-10-20T22:59:00Z'));
    expect(lastAwakeTime(at('2026-10-21T12:00:00Z'), UTC_DAY)).toBe(at('2026-10-21T12:00:00Z'));
  });

  test('late-evening wake-up times are not pushed a day too far', () => {
    const late: AwakeHours = { start: '23:30', end: '06:00', timezone: 'UTC' };
    expect(nextAwakeTime(at('2026-10-21T12:00:00Z'), late)).toBe(at('2026-10-21T23:30:00Z'));
  });

  test('fractional seconds right after wake-up count as awake', () => {
    const chicago: AwakeHours = { start: '08:00', end: '23:00', timezone: 'America/Chicago' };
    expect(isAwake(at('2027-02-15T14:00:00Z') + 0.999, chicago)).toBe(true);
  });

  test('null hours means always awake', () => {
    expect(nextAwakeTime(123, null)).toBe(123);
  });
});

describe('cached timezone offsets', () => {
  test('match lib/events getTimezoneOffsetAt across a year, DST changes included', () => {
    const zones = ['America/Chicago', 'Europe/London', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'Pacific/Chatham', 'UTC'];
    const start = Date.UTC(2026, 0, 1) / 1000;
    const mismatches: string[] = [];
    for (const zone of zones) {
      // Every 31 minutes for a year: lands at varied points inside the 15-minute buckets.
      for (let t = start; t < start + 366 * 86400; t += 31 * 60) {
        const a = timezoneOffsetAt(zone, t), b = getTimezoneOffsetAt(zone, t);
        if (a !== b) mismatches.push(`${zone} ${new Date(t * 1000).toISOString()} cached=${a} orig=${b}`);
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
  }, 60_000);
});
