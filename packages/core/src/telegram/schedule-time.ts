// Parse a human schedule reply in the client's timezone.
// Accepts "18:30", "6pm", "today 17:00", "tomorrow 9am", "2026-12-24 18:00", "+2h".
// Behaviour parity with builder/code/router/parse-schedule-time.js: a bare hour is too
// ambiguous, the time must be at least a minute out and at most 90 days away.
//
// Luxon is not a dependency here, so the zone maths is done with Intl: an IANA zone is
// only ever applied through Intl.DateTimeFormat, never through a fixed offset.

export const MAX_SCHEDULE_DAYS = 90;

export type ScheduleParseResult =
  | { ok: true; publishAt: Date; localLabel: string }
  | { ok: false; reason: string };

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = partFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    partFormatters.set(zone, formatter);
  }
  return formatter;
}

function numericParts(zone: string, date: Date): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of partsFormatter(zone).formatToParts(date)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return out;
}

/** Zone offset (local minus UTC) in milliseconds at the given instant. */
function zoneOffsetMs(zone: string, instantMs: number): number {
  const parts = numericParts(zone, new Date(instantMs));
  const asUtc = Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  // Seconds are preserved, milliseconds are not part of the format: round to the second.
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** Wall-clock time in a zone → the instant it refers to. */
function zonedToUtc(zone: string, wall: WallClock): Date {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0, 0);
  const firstOffset = zoneOffsetMs(zone, guess);
  let instant = guess - firstOffset;
  const secondOffset = zoneOffsetMs(zone, instant);
  // One correction is enough: offsets only change by whole minutes at a DST boundary.
  if (secondOffset !== firstOffset) instant = guess - secondOffset;
  return new Date(instant);
}

function wallClockIn(zone: string, date: Date): WallClock {
  const parts = numericParts(zone, date);
  return {
    year: parts.year ?? 1970,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
  };
}

function addDays(wall: WallClock, days: number): WallClock {
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day) + days * 86_400_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: wall.hour,
    minute: wall.minute,
  };
}

/** True when the instant really lands on the requested wall clock (rejects 2026-02-31). */
function roundTrips(zone: string, wall: WallClock, instant: Date): boolean {
  const actual = wallClockIn(zone, instant);
  return (
    actual.year === wall.year &&
    actual.month === wall.month &&
    actual.day === wall.day &&
    actual.hour === wall.hour &&
    actual.minute === wall.minute
  );
}

const labelFormatters = new Map<string, Intl.DateTimeFormat>();

/** "Thu 24 Dec 2026, 18:00 (Europe/Lagos)" — same shape as the n8n bot used. */
export function formatLocalTime(date: Date, zone: string): string {
  let formatter = labelFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    labelFormatters.set(zone, formatter);
  }
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return `${parts.weekday} ${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} (${zone})`;
}

/** Falls back to UTC when the client's stored timezone is not a zone Intl knows. */
export function safeZone(timezone: string | null | undefined): string {
  if (!timezone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return timezone;
  } catch {
    return 'UTC';
  }
}

const RELATIVE_RE = /^\+\s*(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/;
const ABSOLUTE_RE = /^(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}):(\d{2})$/;
const CLOCK_RE = /^(today|tomorrow)?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/;

export function parseScheduleTime(text: string, timezone: string, now: Date = new Date()): ScheduleParseResult {
  const zone = safeZone(timezone);
  const raw = String(text ?? '').trim().toLowerCase();
  let when: Date | null = null;

  const relative = RELATIVE_RE.exec(raw);
  const absolute = relative ? null : ABSOLUTE_RE.exec(raw);
  const clock = relative || absolute ? null : CLOCK_RE.exec(raw);

  if (relative) {
    const amount = Number(relative[1]);
    const unit = (relative[2] ?? '')[0];
    const ms = unit === 'm' ? amount * 60_000 : unit === 'h' ? amount * 3_600_000 : amount * 86_400_000;
    if (Number.isFinite(ms)) when = new Date(now.getTime() + ms);
  } else if (absolute) {
    const wall: WallClock = {
      year: Number(absolute[1]),
      month: Number(absolute[2]),
      day: Number(absolute[3]),
      hour: Number(absolute[4]),
      minute: Number(absolute[5]),
    };
    if (wall.month >= 1 && wall.month <= 12 && wall.day >= 1 && wall.day <= 31 && wall.hour <= 23 && wall.minute <= 59) {
      const instant = zonedToUtc(zone, wall);
      if (roundTrips(zone, wall, instant)) when = instant;
    }
  } else if (clock) {
    const day = clock[1];
    let hour = Number(clock[2]);
    const twelveHourClock = Boolean(clock[4]);
    const minute = clock[3] === undefined ? 0 : Number(clock[3]);
    const ampm = clock[4];
    const validHour = twelveHourClock ? hour >= 1 && hour <= 12 : hour <= 23;
    if (validHour && ampm === 'pm' && hour < 12) hour += 12;
    if (validHour && ampm === 'am' && hour === 12) hour = 0;
    // A bare number like "18" is too ambiguous; require minutes, am/pm or a day word.
    const specific = clock[3] !== undefined || Boolean(ampm) || Boolean(day);
    if (specific && validHour && minute <= 59) {
      const today = wallClockIn(zone, now);
      let wall: WallClock = { ...today, hour, minute };
      if (day === 'tomorrow') wall = addDays(wall, 1);
      let instant = zonedToUtc(zone, wall);
      if (!day && instant.getTime() <= now.getTime()) {
        wall = addDays(wall, 1);
        instant = zonedToUtc(zone, wall);
      }
      when = instant;
    }
  }

  if (!when || Number.isNaN(when.getTime())) return { ok: false, reason: 'format not recognised' };

  // Never publish earlier than requested. Relative inputs can contain seconds through
  // `now`; ceiling keeps the one-minute safety margin intact instead of shaving it off.
  const publishAt = new Date(Math.ceil(when.getTime() / 60_000) * 60_000);
  if (publishAt.getTime() < now.getTime() + 60_000) {
    return { ok: false, reason: 'choose a time at least 1 minute from now' };
  }
  if (publishAt.getTime() > now.getTime() + MAX_SCHEDULE_DAYS * 86_400_000) {
    return { ok: false, reason: `that is more than ${MAX_SCHEDULE_DAYS} days away` };
  }

  return { ok: true, publishAt, localLabel: formatLocalTime(publishAt, zone) };
}
