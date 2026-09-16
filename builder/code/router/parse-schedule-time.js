// Parse a human schedule reply in the client's timezone.
// Accepts: "18:30", "6pm", "tomorrow 9am", "today 17:00", "2026-12-24 18:00", "+2h", "+30m", "+1d".
const ctx = $('Build Context').first().json;
const zone = ctx.timezone || 'UTC';
const raw = String(ctx.text || '').trim().toLowerCase();
const now = DateTime.now().setZone(zone);

let when = null;
let m;

if ((m = raw.match(/^\+\s*(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/))) {
  const n = Number(m[1]);
  const unit = m[2][0];
  when = now.plus(unit === 'm' ? { minutes: n } : unit === 'h' ? { hours: n } : { days: n });
} else if ((m = raw.match(/^(\d{4}-\d{2}-\d{2})[ t](\d{1,2}):(\d{2})$/))) {
  when = DateTime.fromISO(`${m[1]}T${m[2].padStart(2, '0')}:${m[3]}`, { zone });
} else if ((m = raw.match(/^(today|tomorrow)?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/))) {
  const [, day, h, min, ampm] = m;
  let hour = Number(h);
  const minute = Number(min ?? 0);
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  // A bare number like "18" is too ambiguous; require minutes, am/pm or a day word.
  const specific = min !== undefined || ampm || day;
  if (specific && hour <= 23 && minute <= 59) {
    when = now.set({ hour, minute, second: 0, millisecond: 0 });
    if (day === 'tomorrow') when = when.plus({ days: 1 });
    else if (!day && when <= now) when = when.plus({ days: 1 });
  }
}

let reason = null;
if (!when || !when.isValid) reason = 'format not recognised';
else if (when < now.plus({ minutes: 1 })) reason = 'that time is in the past';
else if (when > now.plus({ days: 90 })) reason = 'that is more than 90 days away';

return [{
  json: {
    chat_id: ctx.chat_id,
    ok: !reason,
    reason,
    publish_at: reason ? null : when.toUTC().toISO(),
    local_label: reason ? null : `${when.toFormat('ccc d LLL yyyy, HH:mm')} (${zone})`,
  },
}];
