// Build the Gemini generateContent request for a post draft (or a revision).
const p = $input.first().json;
const feedback = String($('When Called').first().json.feedback || '').trim();

const list = (arr) => (Array.isArray(arr) ? arr.filter(Boolean) : []);
const brand = [
  `Business name: ${p.client_name}`,
  p.business_description && `About the business: ${p.business_description}`,
  p.audience && `Target audience: ${p.audience}`,
  p.voice && `Brand voice: ${p.voice}`,
  `Language: ${p.language || 'English'}`,
  p.emoji_policy && `Emoji use: ${p.emoji_policy}`,
  p.default_cta && `Default call to action: ${p.default_cta}`,
  list(p.brand_hashtags).length && `Brand hashtags (always relevant): ${list(p.brand_hashtags).join(' ')}`,
  list(p.banned_words).length && `Never use these words: ${list(p.banned_words).join(', ')}`,
  p.sample_posts && `Examples of past posts in the brand's style:\n${p.sample_posts}`,
].filter(Boolean).join('\n');

const system = `You write social media posts for a small business. The business owner reviews every draft before anything is published.

Facebook caption: conversational and complete, usually 40-120 words unless the brief asks for something else. Links and phone numbers are fine when the brief provides them. Use at most 3 hashtags inline.

Instagram caption: the first line must hook the reader because the feed cuts it off after about 125 characters. Use short paragraphs and end with a clear call to action. Do not include URLs because they are not clickable on Instagram; say "link in bio" if a link matters. Do not put hashtags in the caption text.

Hashtags: return 5-15 relevant Instagram hashtags in the hashtags field, mixing broad, niche and local tags. Each starts with # and has no spaces.

Only state prices, dates, offers, addresses and contact details that appear in the brief or brand profile. If something the post clearly needs is missing, write around it and mention it in notes_for_client. Keep notes_for_client to one or two short sentences, or an empty string when nothing is worth flagging.

Write in the brand's language and voice.`;

let text = `<brand_profile>\n${brand}\n</brand_profile>\n\n<brief>\n${p.brief || '(No written brief. Base the post on the attached photo.)'}\n</brief>`;
if (p.source_media_url) text += '\n\nThe attached photo will be published together with both captions.';
if (feedback) {
  text += `\n\n<previous_draft>\nFacebook:\n${p.prev_fb || ''}\n\nInstagram:\n${p.prev_ig || ''}\n</previous_draft>`;
  text += `\n\n<client_feedback>\n${feedback}\n</client_feedback>\n\nRevise the draft to address the client's feedback. Keep everything they did not ask to change.`;
}

const parts = [{ text }];

return [{
  json: {
    post_id: p.post_id,
    chat_id: p.chat_id,
    platforms: p.platforms || [],
    source_media_url: p.source_media_url || null,
    brand_hashtags: list(p.brand_hashtags),
    banned_words: list(p.banned_words),
    feedback,
    request: {
      systemInstruction: {
        parts: [{ text: system }]
      },
      contents: [
        {
          role: 'user',
          parts
        }
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            facebook_caption: { type: 'STRING' },
            instagram_caption: { type: 'STRING' },
            hashtags: { type: 'ARRAY', items: { type: 'STRING' } },
            notes_for_client: { type: 'STRING' }
          },
          required: ['facebook_caption', 'instagram_caption', 'hashtags', 'notes_for_client']
        }
      }
    },
  },
}];
