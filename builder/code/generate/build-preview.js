// Approval message + buttons. Plain text (no parse_mode) so captions never break formatting.
const d = $('Validate Draft').first().json;
const version = $input.first().json.version;
const platforms = d.platforms || [];
const id = d.post_id;

const label = { facebook: 'Facebook', instagram: 'Instagram' };
const parts = [
  `📝 DRAFT v${version} · ${platforms.length ? platforms.map((p) => label[p] || p).join(' + ') : '⚠️ no platform available'}`,
];
if (platforms.includes('facebook')) parts.push(`📘 FACEBOOK\n${d.fb_caption.slice(0, 1400)}`);
if (platforms.includes('instagram')) parts.push(`📸 INSTAGRAM\n${d.ig_caption}`);
if (!d.source_media_url) parts.push('ℹ️ No photo attached, so Instagram is skipped. Send a photo with your brief to include Instagram.');
if (d.notes) parts.push(`💡 ${d.notes}`);
for (const w of d.warnings) parts.push(`⚠️ ${w}`);
parts.push('Nothing is posted until you tap 🚀 or schedule it.');

let text = parts.join('\n\n');
if (text.length > 4096) text = text.slice(0, 4090) + '…';

const inline_keyboard = [];
if (platforms.length) {
  inline_keyboard.push([
    { text: '🚀 Publish now', callback_data: `p:pub:${id}` },
    { text: '🕒 Schedule', callback_data: `p:sch:${id}` },
  ]);
}
inline_keyboard.push([
  { text: '✏️ Edit', callback_data: `p:edt:${id}` },
  { text: '🔁 Regenerate', callback_data: `p:rgn:${id}` },
  { text: '❌ Discard', callback_data: `p:rej:${id}` },
]);

return [{
  json: {
    chat_id: d.chat_id,
    text,
    reply_markup: { inline_keyboard },
    photo_url: d.source_media_url,
    has_photo: !!d.source_media_url,
  },
}];
