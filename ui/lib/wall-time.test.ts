// schedules#50 — an opening time («09:00», stored as 'HH:MM') is shown and typed in the HUB's
// clock: 24 h in Spanish, AM/PM in English. These are the two halves the screen uses: format a
// stored wall time for the active language, and read back what a person typed or pasted.
import { describe, expect, it } from 'vitest';
import { formatWallTime, parseWallTime } from './wall-time';

// Intl separates «AM/PM» with a narrow no-break space; the assertions compare plain spaces.
const plain = (s: string) => s.replace(/\s/g, ' ');

describe('formatWallTime — a stored HH:MM in the hub clock', () => {
  it('Spanish reads 24 h', () => {
    expect(formatWallTime('09:00', 'es')).toBe('09:00');
    expect(formatWallTime('14:30', 'es')).toBe('14:30');
  });

  it('English reads AM/PM', () => {
    expect(plain(formatWallTime('09:00', 'en'))).toBe('09:00 AM');
    expect(plain(formatWallTime('14:30', 'en'))).toBe('02:30 PM');
  });

  it('midnight is 00:00 in Spanish, never 24:00 (the day boundary would move)', () => {
    expect(formatWallTime('00:00', 'es')).toBe('00:00');
    expect(plain(formatWallTime('00:00', 'en'))).toBe('12:00 AM');
  });

  it('a stored value with seconds is still a wall time', () => {
    expect(formatWallTime('18:00:00', 'es')).toBe('18:00');
  });

  it('the device timezone never moves it (a wall time has no zone)', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'Pacific/Kiritimati';
    try {
      expect(formatWallTime('09:00', 'es')).toBe('09:00');
    } finally {
      process.env.TZ = previous;
    }
  });

  it('anything that is not a wall time is returned untouched (empty stays empty)', () => {
    expect(formatWallTime('', 'es')).toBe('');
    expect(formatWallTime('25:00', 'es')).toBe('25:00');
    expect(formatWallTime('abc', 'en')).toBe('abc');
  });
});

describe('parseWallTime — what a person types or pastes, back to HH:MM', () => {
  it('reads the 24 h form, with one or two hour digits', () => {
    expect(parseWallTime('14:30')).toBe('14:30');
    expect(parseWallTime('9:05')).toBe('09:05');
    expect(parseWallTime('09.30')).toBe('09:30');
  });

  it('reads digits only — the phone numeric keypad has no colon', () => {
    expect(parseWallTime('1430')).toBe('14:30');
    expect(parseWallTime('930')).toBe('09:30');
    expect(parseWallTime('9')).toBe('09:00');
    expect(parseWallTime('17')).toBe('17:00');
  });

  it('reads back what the English clock shows, and the Spanish 12 h spelling', () => {
    expect(parseWallTime('02:30 PM')).toBe('14:30');
    expect(parseWallTime('02:30 PM')).toBe('14:30');
    expect(parseWallTime('2:30 pm')).toBe('14:30');
    expect(parseWallTime('12:00 AM')).toBe('00:00');
    expect(parseWallTime('12:15 p. m.')).toBe('12:15');
    expect(parseWallTime('9 am')).toBe('09:00');
  });

  it('ignores seconds and surrounding blanks', () => {
    expect(parseWallTime('  18:00:00 ')).toBe('18:00');
  });

  it('refuses what is not a time (a half-typed value is not the last valid hour)', () => {
    for (const bad of ['', '14:', '1:3', '24:00', '2400', '12:60', '13:00 pm', '0 am', '12345', 'abc', '14:30x']) {
      expect(parseWallTime(bad), bad).toBeNull();
    }
  });
});
