const s = $('Plan Publish').first().json;
const res = $input.first().json;
// /photos returns { id: photoId, post_id }, /feed returns { id: "<page>_<post>" }.
const postId = res.post_id || res.id;
return [{ json: { ...s, fb: { ...s.fb, post_id: postId, permalink: `https://www.facebook.com/${postId}` } } }];
