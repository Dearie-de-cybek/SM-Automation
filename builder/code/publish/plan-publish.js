// Decide what to publish where. Platforms that already have a post ID are skipped, so a retry never double-posts.
const p = $input.first().json;
const wanted = p.platforms || [];

const s = {
  post_id: p.post_id,
  chat_id: p.chat_id,
  access_token: p.access_token,
  media_url: p.source_media_url || null,
  fb_caption: p.fb_caption || '',
  ig_caption: p.ig_caption || '',
  fb_page_id: p.fb_page_id,
  ig_user_id: p.ig_user_id,
  fb: { wanted: wanted.includes('facebook'), post_id: p.fb_post_id, permalink: p.fb_permalink, error: null },
  ig: { wanted: wanted.includes('instagram'), media_id: p.ig_media_id, permalink: p.ig_permalink, container_id: null, error: null },
};

if (s.fb.wanted && !s.fb.post_id) {
  if (!p.access_token) s.fb.error = 'Meta access token is missing for this client.';
  else if (!p.fb_page_id) s.fb.error = 'Facebook Page ID is not configured.';
}
if (s.ig.wanted && !s.ig.media_id) {
  if (!p.access_token) s.ig.error = 'Meta access token is missing for this client.';
  else if (!p.ig_user_id) s.ig.error = 'Instagram account ID is not configured.';
  else if (!s.media_url) s.ig.error = 'Instagram posts need a photo.';
}

s.do_fb = s.fb.wanted && !s.fb.post_id && !s.fb.error;
s.do_ig = s.ig.wanted && !s.ig.media_id && !s.ig.error;

s.fb_request = s.media_url
  ? { path: `${p.fb_page_id}/photos`, body: { url: s.media_url, caption: s.fb_caption, published: true } }
  : { path: `${p.fb_page_id}/feed`, body: { message: s.fb_caption } };

return [{ json: s }];
