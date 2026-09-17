// Parse a human schedule reply in the client's timezone.
// Accepts "18:30", "6pm", "today 17:00", "tomorrow 9am", "2026-12-24 18:00", "+2h".
// Behaviour parity with builder/code/router/parse-schedule-time.js: a bare hour is too
// ambiguous, the time must be at least a minute out and at most 90 days away.

export const MAX_SCHEDULE_DAYS = 90;

export type ScheduleParseResult =
  | { ok: true; publishAt: Date; localLabel: string }
  | { ok: false; reason: string };

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export function parseScheduleTime(_text: string, _timezone: string, _now: Date = new Date()): ScheduleParseResult {
  return ni('telegram.parseScheduleTime');
}
