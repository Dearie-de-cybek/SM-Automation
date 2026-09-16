const s = $('Prep IG').first().json;
const mediaId = $('IG: Publish').first().json.id;
const permalink = $input.first().json.permalink || null;
const containerId = $('IG: Create Container').first().json.id;
return [{ json: { ...s, ig: { ...s.ig, media_id: mediaId, permalink, container_id: containerId } } }];
