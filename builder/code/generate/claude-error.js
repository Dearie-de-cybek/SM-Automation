// HTTP error from the Gemini/AI API (after node-level retries).
const { request, ...base } = $('Build AI Request').first().json;
const err = $input.first().json.error ?? {};
const message = typeof err === 'string' ? err : err.message || 'unknown error';
return [{ json: { ...base, ok: false, reason: `the AI service failed (${String(message).slice(0, 200)})` } }];
