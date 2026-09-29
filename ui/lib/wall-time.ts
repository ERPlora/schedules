// schedules#50 — an opening time is a WALL time ('HH:MM', the civil reading of the business
// clock; see migrations/postgres/001_init.sql), shown and typed in the HUB's language: 24 h in
// Spanish, AM/PM in English. A native `<input type="time">` cannot do it: Chromium paints it with
// the BROWSER's (operating system's) clock and ignores the hub language — a Spanish hub on a
// US-English laptop read «02:00 PM». The same finding appointments#214 closed for the time of an
// appointment; modules share no JS, so this is the schedules copy of that reading.

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

const STORED = /^(\d{2}):(\d{2})(?::\d{2})?$/;

/** Formats a stored `HH:MM[:SS]` wall time in the given locale's own clock (`es` → `14:30`,
 *  `en` → `02:30 PM`), 2-digit hour and minute. Built from `Date.UTC` and formatted with
 *  `timeZone: 'UTC'`, so the device's timezone never moves it (a wall time has none to move).
 *  `hourCycle` is left to the locale on purpose: that IS the language's clock. Anything that is
 *  not a valid wall time comes back untouched, so a list never blanks a value it cannot read. */
export function formatWallTime(time: string, locale: string): string {
  const match = time.match(STORED);
  if (!match) return time;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return time;
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(2026, 0, 1, hour, minute)));
  } catch {
    // Intl threw on the given locale: fall back to the 24-hour form below.
  }
  return `${pad2(hour)}:${pad2(minute)}`;
}

// H, HH, H:MM, HH:MM, H.MM (optional :SS) — or digits only (HMM, HHMM), because the phone's
// numeric keypad has no colon — with an optional meridiem as English and Spanish write it
// («PM», «pm», «p.m.», «p. m.»). Intl separates it with a narrow no-break space, which `\s` covers.
const TYPED = /^(?:(\d{1,2})(?:[:.](\d{2})(?::\d{2})?)?|(\d{1,2})(\d{2}))(?:\s*([ap])\.?\s?m\.?)?$/i;

/** Reads a time typed or pasted as free text back to the stored `HH:MM`, or `null` when it is
 *  not (yet) a time — a half-typed «14:» must never keep the last valid hour. */
export function parseWallTime(text: string): string | null {
  const match = text.trim().match(TYPED);
  if (!match) return null;
  const [, hourText, minuteText, packedHour, packedMinute, meridiem] = match;
  let hour = Number(hourText ?? packedHour);
  const minute = Number(minuteText ?? packedMinute ?? 0);
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    const isPm = meridiem.toLowerCase() === 'p';
    hour = isPm ? (hour === 12 ? 12 : hour + 12) : hour === 12 ? 0 : hour;
  } else if (hour > 23) {
    return null;
  }
  return `${pad2(hour)}:${pad2(minute)}`;
}
