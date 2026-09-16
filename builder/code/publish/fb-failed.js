// @include shared/meta-error.js

const s = $('Plan Publish').first().json;
return [{ json: { ...s, fb: { ...s.fb, error: metaError($input.first().json) } } }];
