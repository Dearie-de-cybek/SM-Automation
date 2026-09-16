// Flatten a Telegram update (message or button press) into one shape.
const update = $input.first().json;
const out = { update_id: update.update_id ?? null };

if (update.callback_query) {
  const cq = update.callback_query;
  out.kind = 'callback';
  out.chat_id = cq.message?.chat?.id ?? cq.from?.id ?? null;
  out.from_id = cq.from?.id ?? null;
  out.callback_id = cq.id;
  out.callback_data = cq.data ?? '';
  out.message_id = cq.message?.message_id ?? null;
  out.text = '';
  out.photo_file_id = null;
} else {
  const m = update.message ?? {};
  const photos = m.photo ?? [];
  out.chat_id = m.chat?.id ?? null;
  out.from_id = m.from?.id ?? null;
  out.message_id = m.message_id ?? null;
  // Telegram sends several sizes; the last one is the largest.
  out.photo_file_id = photos.length ? photos[photos.length - 1].file_id : null;
  out.text = String(m.text ?? m.caption ?? '').trim();
  if (out.photo_file_id) out.kind = 'photo';
  else if (out.text.startsWith('/')) out.kind = 'command';
  else if (out.text) out.kind = 'text';
  else out.kind = 'unsupported';
}

// Updates without a chat (e.g. edited messages we did not subscribe to) are dropped.
if (!out.chat_id) return [];
return [{ json: out }];
