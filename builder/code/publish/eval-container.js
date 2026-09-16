// Instagram processes the image asynchronously; publish only once the container is FINISHED.
const MAX_POLLS = 20;
const s = $('Prep IG').first().json;
const status = $input.first().json;
const polls = $runIndex + 1;

let route = 1; // 0 = ready, 1 = wait and poll again, 2 = failed
let ig_error = null;
if (status.status_code === 'FINISHED') route = 0;
else if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
  route = 2;
  ig_error = `Instagram could not process the image (${status.status || status.status_code}).`;
} else if (polls >= MAX_POLLS) {
  route = 2;
  ig_error = 'Instagram took too long to process the image.';
}

return [{ json: { ...s, route, ig_error } }];
