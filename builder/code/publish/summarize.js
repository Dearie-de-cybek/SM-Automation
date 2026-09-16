// Final status + message for the client. The access token is deliberately left out from here on.
const s = $input.first().json;
const { fb, ig } = s;

const fbOk = !fb.wanted || !!fb.post_id;
const igOk = !ig.wanted || !!ig.media_id;
const anyOk = (fb.wanted && !!fb.post_id) || (ig.wanted && !!ig.media_id);
const nothingWanted = !fb.wanted && !ig.wanted;

const status = nothingWanted ? 'failed' : fbOk && igOk ? 'published' : anyOk ? 'partially_published' : 'failed';

const lines = [
  status === 'published' ? '✅ Published!' : status === 'partially_published' ? '⚠️ Partly published' : '❌ Publishing failed',
];
if (nothingWanted) lines.push('No platform was selected for this post.');
if (fb.wanted) lines.push(fb.post_id ? `📘 Facebook: ${fb.permalink}` : `📘 Facebook failed: ${fb.error || 'unknown error'}`);
if (ig.wanted) {
  lines.push(ig.media_id ? `📸 Instagram: ${ig.permalink || 'posted (link unavailable)'}` : `📸 Instagram failed: ${ig.error || 'unknown error'}`);
}
if (status !== 'published') lines.push('Fix the issue, then tap 🔁 Retry. Anything already posted will not be posted twice.');

const errors = [fb.error && `facebook: ${fb.error}`, ig.error && `instagram: ${ig.error}`].filter(Boolean).join(' | ');

return [{
  json: {
    post_id: s.post_id,
    chat_id: s.chat_id,
    status,
    fb_post_id: fb.post_id || '',
    fb_permalink: fb.permalink || '',
    ig_media_id: ig.media_id || '',
    ig_permalink: ig.permalink || '',
    ig_container_id: ig.container_id || '',
    error: status === 'published' ? '' : errors || 'No platform selected',
    text: lines.join('\n\n'),
    reply_markup: status === 'published'
      ? undefined
      : { inline_keyboard: [[{ text: '🔁 Retry', callback_data: `p:rty:${s.post_id}` }]] },
  },
}];
