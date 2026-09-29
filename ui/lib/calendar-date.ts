// schedules#54 — a calendar date ('YYYY-MM-DD', the day of a special day or of a temporary change)
// shown and typed in the HUB's day/month order: day first in Spanish, month first in English. A
// native `<input type="date">` cannot do it: Chromium paints it with the BROWSER's (operating
// system's) locale and ignores the hub language — a Spanish hub on a US-English laptop read
// «12/24/2026», and «03/04/2026» typed as the 3rd of April saved the 4th of March. The same finding
// appointments#205 closed for the date of an appointment (`ui/lib/typed-start.ts` there); modules
// share no JS, so this is the schedules copy of that reading.

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** The `YYYY-MM-DD` string, or `null` if the day/month/year is not a real calendar date. */
function toIsoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1) return null;
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > days[month - 1]) return null;
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/** Whether the language writes the day before the month, read from how `Intl` itself orders a
 *  formatted date. Day first when the locale is unknown or `Intl` throws. */
function isDayFirst(locale: string): boolean {
  try {
    const parts = new Intl.DateTimeFormat(locale || undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(
      new Date(Date.UTC(2026, 8, 26)),
    );
    const month = parts.findIndex((p) => p.type === 'month');
    const day = parts.findIndex((p) => p.type === 'day');
    return month === -1 || day === -1 || day < month;
  } catch {
    return true;
  }
}

const STORED = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Formats a stored `YYYY-MM-DD` date as a numeric date in the locale's own day/month order
 *  (`es` → `24/12/2026`, `en` → `12/24/2026`), 2-digit day/month and 4-digit year, always joined
 *  by `/` so the field can be typed back unchanged. Built from `Date.UTC` and formatted in UTC: the
 *  device's timezone never moves it (a calendar date names no instant). `''` for anything that is
 *  not a real calendar date. */
export function formatCalendarDate(iso: string, locale: string): string {
  const match = iso.match(STORED);
  if (!match) return '';
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!toIsoDate(year, month, day)) return '';
  try {
    const parts = new Intl.DateTimeFormat(locale || undefined, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'UTC',
    }).formatToParts(new Date(Date.UTC(year, month - 1, day)));
    const ordered = parts.filter((p) => p.type === 'day' || p.type === 'month' || p.type === 'year').map((p) => p.value);
    if (ordered.length === 3) return ordered.join('/');
  } catch {
    // Intl threw on the given locale: fall back to the day-first form below.
  }
  return `${pad2(day)}/${pad2(month)}/${String(year).padStart(4, '0')}`;
}

// D/M/YYYY with `/`, `.`, `-` or spaces between the parts — or digits only (DDMMYYYY), because the
// phone's numeric keypad has no slash.
const TYPED = /^(?:(\d{1,2})\s*[/.\-\s]\s*(\d{1,2})\s*[/.\-\s]\s*(\d{4})|(\d{2})(\d{2})(\d{4}))$/;

/** Reads a date typed or pasted as free text — in the locale's day/month order, or ISO — back to
 *  the stored `YYYY-MM-DD`, or `null` when it is not (yet) a real date: a half-typed «24/12» must
 *  never keep the last valid date. */
export function parseCalendarDate(text: string, locale: string): string | null {
  const trimmed = text.trim();
  const iso = trimmed.match(STORED);
  if (iso) return toIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const match = trimmed.match(TYPED);
  if (!match) return null;
  const first = Number(match[1] ?? match[4]);
  const second = Number(match[2] ?? match[5]);
  const year = Number(match[3] ?? match[6]);
  return isDayFirst(locale) ? toIsoDate(year, second, first) : toIsoDate(year, first, second);
}
