// Button payloads look like "p:<action>:<post uuid>".
const ctx = $('Build Context').first().json;
const [prefix, action, postId] = String(ctx.callback_data).split(':');
const valid = prefix === 'p' && /^[0-9a-f-]{36}$/i.test(postId ?? '');

return [{
  json: {
    ...ctx,
    action: valid ? action : 'invalid',
    // Placeholder keeps the ::uuid cast in the next query from failing.
    post_id: valid ? postId : '00000000-0000-0000-0000-000000000000',
  },
}];
