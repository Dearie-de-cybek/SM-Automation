// Object-storage key for the client's photo. Telegram re-encodes photos as JPEG.
const ctx = $input.first().json;
const media_key = `posts/${ctx.client_id}/${Date.now()}-${ctx.message_id}.jpg`;
return [{ json: { ...ctx, media_key } }];
