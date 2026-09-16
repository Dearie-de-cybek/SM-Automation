// Only allow a button if the post is still in a state where it makes sense.
const ctx = $('Parse Callback').first().json;
const post = $input.first().json;

const ACTIONS = ['pub', 'sch', 'edt', 'rgn', 'rej', 'rty', 'stale'];
const ALLOWED_FROM = {
  pub: ['pending_approval', 'scheduled'],
  sch: ['pending_approval', 'scheduled'],
  edt: ['pending_approval'],
  rgn: ['pending_approval'],
  rej: ['pending_approval', 'scheduled'],
  rty: ['failed', 'partially_published'],
};

let action = ctx.action;
if (!post.post_id || !ALLOWED_FROM[action]?.includes(post.status)) action = 'stale';

return [{
  json: {
    ...ctx,
    post_status: post.status ?? 'missing',
    action,
    action_index: ACTIONS.indexOf(action),
  },
}];
