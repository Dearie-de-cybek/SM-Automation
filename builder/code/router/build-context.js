// Merge the update with the client lookup and decide which branch handles it.
const update = $('Normalize Update').first().json;
const client = $input.first().json;

const ROUTES = [
  'unauthorized', 'help', 'new_post', 'callback', 'edit_feedback',
  'schedule_time', 'cancel', 'link_chat', 'login_link',
];

const ctx = {
  ...update,
  client_id: client.client_id ?? null,
  client_name: client.client_name ?? null,
  is_admin: client.is_admin === true,
  timezone: client.timezone ?? 'UTC',
  session_mode: client.session_mode ?? null,
  session_post_id: client.session_post_id ?? null,
};

let cmd = null;
let arg = '';
if (update.kind === 'command') {
  cmd = update.text.split(/\s+/)[0].split('@')[0].toLowerCase();
  arg = update.text.replace(/^\/\S+\s*/, '').trim();
}

let route;
if (cmd === '/start' && arg.startsWith('link_')) {
  // Deep link from the dashboard signup page: t.me/<bot>?start=link_<code>
  ctx.link_code = arg.slice('link_'.length);
  route = 'link_chat';
} else if (cmd === '/dashboard' || cmd === '/login' || (cmd === '/start' && arg === 'login')) {
  route = ctx.client_id || ctx.is_admin ? 'login_link' : 'unauthorized';
} else if (!ctx.client_id) {
  route = 'unauthorized';
} else if (update.kind === 'callback') {
  route = 'callback';
} else if (cmd) {
  if (cmd === '/cancel') route = 'cancel';
  else if ((cmd === '/new' || cmd === '/post') && arg) {
    ctx.text = arg;
    route = 'new_post';
  } else route = 'help';
} else if (update.kind === 'text' && ctx.session_mode === 'awaiting_edit') {
  route = 'edit_feedback';
} else if (update.kind === 'text' && ctx.session_mode === 'awaiting_schedule') {
  route = 'schedule_time';
} else if (update.kind === 'photo' || update.kind === 'text') {
  route = 'new_post';
} else {
  route = 'help';
}

ctx.route = route;
ctx.route_index = ROUTES.indexOf(route);
return [{ json: ctx }];
