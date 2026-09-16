// Pull a readable message out of an HTTP Request node error item (Graph API errors are JSON inside the text).
function metaError(item) {
  const e = item?.error ?? item ?? {};
  const raw = typeof e === 'string' ? e : [e.message, e.description].filter(Boolean).join(' ');
  const m = raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return (m ? m[1] : raw || 'Unknown error').slice(0, 500);
}
