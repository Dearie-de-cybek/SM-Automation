// Parse Gemini/AI structured output and enforce platform limits.
const { request, ...base } = $('Build AI Request').first().json;
const res = $input.first().json;
const fail = (reason) => [{ json: { ...base, ok: false, reason } }];

// Gemini finish reasons
const candidate = res.candidates?.[0];
if (candidate?.finishReason === 'SAFETY') return fail('the AI declined this brief due to safety filters. Try rephrasing it');
if (candidate?.finishReason === 'MAX_TOKENS' || res.stop_reason === 'max_tokens') return fail('the draft was cut off. Try a shorter brief');
if (res.stop_reason === 'refusal') return fail('the AI declined this brief. Try rephrasing it');

// Extract text from Gemini candidates or standard response format
const textOutput =
  candidate?.content?.parts?.[0]?.text ||
  (res.content || []).find((b) => b.type === 'text')?.text ||
  res.text ||
  '';

if (!textOutput) return fail('the AI returned an empty response');

let d;
try {
  d = JSON.parse(textOutput);
} catch (e) {
  return fail('the AI returned malformed output');
}

const IG_CAPTION_MAX = 2200;
const IG_HASHTAGS_MAX = 30;
const FB_CAPTION_MAX = 5000;

const clean = (s) => String(s || '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();

const fb = clean(d.facebook_caption).slice(0, FB_CAPTION_MAX);
const igBody = clean(String(d.instagram_caption || '').replace(/https?:\/\/\S+/g, ''));

const tags = [...new Set(
  [...base.brand_hashtags, ...(d.hashtags || [])]
    .map((t) => '#' + String(t).replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter((t) => t.length > 1),
)].slice(0, IG_HASHTAGS_MAX);

// Drop hashtags from the end until the caption fits; truncate the body only as a last resort.
let ig = igBody;
for (let n = tags.length; n >= 0; n--) {
  ig = n ? `${igBody}\n\n${tags.slice(0, n).join(' ')}` : igBody;
  if (ig.length <= IG_CAPTION_MAX) break;
}
if (ig.length > IG_CAPTION_MAX) ig = ig.slice(0, IG_CAPTION_MAX - 1) + '…';

const warnings = [];
const lower = `${fb}\n${ig}`.toLowerCase();
for (const word of base.banned_words) {
  if (word && lower.includes(word.toLowerCase())) warnings.push(`Contains a banned word: "${word}"`);
}
if (!fb) warnings.push('Facebook caption is empty');
if (!igBody) warnings.push('Instagram caption is empty');

return [{
  json: {
    ...base,
    ok: true,
    fb_caption: fb,
    ig_caption: ig,
    notes: clean(d.notes_for_client),
    warnings,
    model: res.modelVersion || res.model || 'gemini-2.5-flash',
  },
}];
