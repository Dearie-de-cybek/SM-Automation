// @include shared/meta-error.js

const s = $('Prep IG').first().json;
const item = $input.first().json;

let containerId = null;
try {
  containerId = $('IG: Create Container').first().json.id ?? null;
} catch (e) {
  // Container step did not run.
}

let error = item.ig_error || metaError(item);
if (/aspect ratio/i.test(error)) {
  error += ' Instagram only accepts images between 4:5 (portrait) and 1.91:1 (landscape). Crop the photo and send the brief again.';
}

return [{ json: { ...s, ig: { ...s.ig, error, container_id: containerId } } }];
