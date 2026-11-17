/**
 * Cloudflare Worker - SMS shortener
 *
 * Rewords an SMS message so it fits in fewer SMS segments (e.g. 2 → 1, i.e.
 * ≤160 GSM-7 characters) while keeping its meaning. Used by Jethro's SMS
 * composer to offer a cheaper alternative for multi-recipient sends.
 *
 * Endpoints:
 *   POST /api/sms-shorten  { message: string, segments?: number, max_cut?: number }
 *     Authorization: Bearer <key>
 *   → 200 { message, fits, attempts, target, original: SegmentInfo, result: SegmentInfo }
 *   → 401 { error: 'Unauthorized' }; 403 { error: 'consent_required' | 'consent_outdated',
 *     service, privacyUrl } (from jethro.au); 503 when jethro.au cannot be asked
 *   GET /sms-shortener/privacy  → the privacy page (privacy.js)
 *
 * The model (Workers AI) only proposes wording; this Worker counts segments
 * itself and retries with tighter budgets, because LLMs cannot count
 * characters reliably. Placeholder tokens (%firstname%, %(shorten "…")%),
 * URLs and phone numbers must survive the rewrite verbatim, or the attempt is
 * rejected.
 *
 * Keys are jethro.au API keys, issued by the jethro.au account Worker (the
 * URL shortener), which also records each organisation's consent to this
 * service. Every request is checked there through the ACCOUNT service
 * binding (GET /api/authorize?service=sms-shortener). The bootstrap
 * env.API_KEY secret is also accepted, without asking.
 *
 * Deploy: cf deploy
 */

import { PRIVACY_PATH, privacyPage } from './privacy.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/** Workers AI model used when env.MODEL is unset. */
export const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** Longest message accepted (10 GSM-7 segments); bounds model cost per call. */
export const MAX_INPUT_LENGTH = 1530;

/** Model calls per request: the first try plus retries (too long, lost a token, or cut too much). */
export const MAX_ATTEMPTS = 3;

/**
 * Default largest share of the text a rewrite may have to cut (requests may
 * set their own with max_cut, 0 to 1; 1 = always try). Beyond it (e.g. 300
 * characters into 160) a rewording would lose meaning, so no model call is
 * made; just over a boundary (e.g. 161 characters) is always worth a try.
 */
export const MAX_CUT_SHARE = 0.3;

/**
 * How far under the limit a rewrite may land and still count as a minimal
 * edit. Fitting rewrites shorter than that cut more than needed, so the
 * model is asked to put wording back.
 */
export const AIM_WINDOW = 20;

/**
 * How far past the real limit the model is first asked to aim. It reliably
 * undershoots (by 20-40 characters on 160), and the code only keeps
 * rewrites that fit, so aiming a little high lands closest to the limit.
 */
export const ASK_ABOVE = 15;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === '/api/sms-shorten' && request.method === 'POST') {
      return handleShorten(request, env);
    }

    if (url.pathname === PRIVACY_PATH && (request.method === 'GET' || request.method === 'HEAD')) {
      return new Response(privacyPage(env, env.MODEL || DEFAULT_MODEL), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
      });
    }

    return new Response(`SMS shortener - POST /api/sms-shorten; privacy: ${PRIVACY_PATH}`, { status: 200 });
  },
};

/**
 * POST /api/sms-shorten — reword a message to fit in fewer segments.
 */
async function handleShorten(request, env) {
  const auth = await authorize(request, env);
  if (auth.error) return auth.error;

  if (env.RATE_LIMITER) {
    const { success } = await env.RATE_LIMITER.limit({ key: auth.keyId || 'bootstrap' });
    if (!success) return jsonResponse({ error: 'Rate limit exceeded' }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Body must be JSON' }, 400);
  }
  const { message, segments, max_cut: maxCut } = body ?? {};
  if (typeof message !== 'string' || message.trim() === '') {
    return jsonResponse({ error: 'message must be a non-empty string' }, 400);
  }
  if (message.length > MAX_INPUT_LENGTH) {
    return jsonResponse({ error: `message must be at most ${MAX_INPUT_LENGTH} characters` }, 400);
  }
  if (segments !== undefined && !(Number.isInteger(segments) && segments >= 1)) {
    return jsonResponse({ error: 'segments must be a positive integer' }, 400);
  }
  if (maxCut !== undefined && !(typeof maxCut === 'number' && maxCut >= 0 && maxCut <= 1)) {
    return jsonResponse({ error: 'max_cut must be a number from 0 to 1' }, 400);
  }

  try {
    const result = await shortenMessage(message, segments ?? null, (messages) => runModel(env, messages), maxCut ?? MAX_CUT_SHARE);
    return jsonResponse(result);
  } catch (error) {
    console.error('Model error:', error);
    return jsonResponse({ error: 'Model unavailable' }, 502);
  }
}

/**
 * Reword $message until it fits in $wanted segments (default: one fewer than
 * it uses now), or MAX_ATTEMPTS model calls have been made, keeping as much
 * of the sender's own wording and voice as possible ({@link buildPrompt}).
 *
 * The model undershoots length targets (by 20-40 characters on 160), so it is
 * asked for a range reaching ASK_ABOVE characters past the real limit; the
 * code keeps only rewrites that fit. A rewrite that fits but lands more than
 * AIM_WINDOW under the limit cut more than needed: it is kept as a fallback
 * and the model is asked to put wording back. One that is too long lowers the
 * next ask. Of the rewrites that fit, the longest wins.
 *
 * No model call is made when normalising alone fits, or when fitting would
 * mean cutting more than $maxCut of the text ({@link cutShare}).
 *
 * Pure apart from the injected `complete(messages) → Promise<string>`, so it
 * is testable without Workers AI.
 *
 * @returns {Promise<{message: string, fits: boolean, attempts: number, target: number,
 *   original: SegmentInfo, result: SegmentInfo}>}
 *   message: the longest rewrite that fits, else the shortest acceptable one
 *   (the normalised input when no attempt was shorter); fits: result.segments <= target.
 */
export async function shortenMessage(message, wanted, complete, maxCut = MAX_CUT_SHARE) {
  const original = segmentInfo(message);
  const cleaned = normalise(message);
  const before = segmentInfo(cleaned);

  if (before.segments === 1 || (wanted != null && before.segments <= wanted)) {
    return { message: cleaned, fits: true, attempts: 0, target: wanted ?? 1, original, result: before };
  }

  // Rewrites are GSM-7, so start from the text without emoji and other
  // non-GSM characters: dropping them alone may save several segments (a
  // UCS-2 segment holds 70 characters, a GSM-7 one 160). Then aim one
  // segment lower when that needs at most $maxCut cut. A requested
  // target is a maximum: a better one is used when available.
  const plainText = stripNonGsm(cleaned);
  const plain = segmentInfo(plainText);
  const best = plain.segments > 1 && cutShare(plain, plain.segments - 1) <= maxCut ? plain.segments - 1 : plain.segments;
  const target = wanted != null && wanted < best ? wanted : best;

  if (target >= before.segments) {
    return { message: cleaned, fits: false, attempts: 0, target: before.segments - 1, original, result: before };
  }
  const mustKeep = protectedTokens(cleaned);
  if (plain.segments <= target && mustKeep.every((t) => plainText.includes(t))) {
    return { message: plainText, fits: true, attempts: 0, target, original, result: plain };
  }
  if (cutShare(plain, target) > maxCut) {
    return { message: cleaned, fits: false, attempts: 0, target, original, result: before };
  }

  const limit = gsmCapacity(target);
  let fit = null;             // longest acceptable rewrite that fits
  let fallback = plainText;   // shortest acceptable rewrite, when none fits
  let fallbackInfo = plain;
  let feedback = null;
  let ceiling = limit + ASK_ABOVE;
  let attempt = 0;

  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    const out = normalise(stripQuotes(await complete(buildPrompt(cleaned, plain.length, ceiling, mustKeep, feedback))));
    const info = segmentInfo(out);
    const lost = mustKeep.filter((t) => !out.includes(t));
    const acceptable = out !== '' && lost.length === 0;

    if (acceptable && info.segments <= target) {
      if (!fit || info.length > fit.info.length) fit = { out, info };
      if (info.length >= limit - AIM_WINDOW) break;
      feedback = { answer: out, text: `That is only ${info.length} characters, ${limit - info.length} under the limit of ${limit}: `
        + `you cut too much. Put back wording from the original message (its greeting, sign-off, personal phrases and details), `
        + `in the sender's own voice, until it is ${limit - AIM_WINDOW} to ${limit} characters.` };
      continue;
    }
    if (acceptable && info.length < fallbackInfo.length) {
      fallback = out;
      fallbackInfo = info;
    }
    ceiling = Math.min(ceiling, limit) - 10 * attempt;
    feedback = { answer: out, text: lost.length
      ? `You dropped required tokens: ${lost.join('  ')}. Include each exactly as written.`
      : `That was ${info.length} characters; it must be at most ${limit}. Shorten it a little, keeping the sender's voice.` };
  }
  return fit
    ? { message: fit.out, fits: true, attempts: attempt, target, original, result: fit.info }
    : { message: fallback, fits: false, attempts: attempt, target, original, result: fallbackInfo };
}

/**
 * Example exchange shown to the model before the real message: an informal,
 * first-person SMS trimmed to just under 160 characters, keeping its voice,
 * greeting and sign-off. Models otherwise tend to summarise into third-person
 * notices ("Sam hosts games night…") far shorter than needed.
 */
const EXAMPLE = {
  message: "Hi all! Just a quick reminder that I'm running the youth group games night this Friday at 7pm in the church hall. "
    + 'Please bring a friend and some snacks to share if you can. Thanks heaps, Sam',
  rewrite: "Hi all! Quick reminder I'm running youth group games night Fri 7pm in church hall. Pls bring a friend & snacks to share if you can. Thanks heaps, Sam",
};

/**
 * Chat messages asking the model for one rewrite of $message, $length
 * characters as plain GSM-7, to between $ceiling - AIM_WINDOW and $ceiling
 * characters: an editor's trim in the sender's own voice, after one worked
 * example ({@link EXAMPLE}).
 *
 * @param {{answer: string, text: string} | null} feedback  the previous
 *   answer and what was wrong with it, for a retry
 */
export function buildPrompt(message, length, ceiling, mustKeep, feedback) {
  const ask = (len, max) => `This message is ${len} characters. Shorten it to between ${max - AIM_WINDOW} and ${max} characters `
    + `(remove about ${len - max + AIM_WINDOW / 2} characters):\n\n`;
  const messages = [
    {
      role: 'system',
      content:
        'You edit SMS messages sent by a church to its members so they fit a length limit. '
        + 'You are an editor, not a summariser: return the sender\'s own message, trimmed as little as possible.\n'
        + '- Keep the sender\'s voice: the same person ("I", "we", "you"), the same greeting and sign-off, the same warmth and informality. '
        + 'Never turn it into a notice about the sender (never "I will host" -> "Sam hosts").\n'
        + '- Keep every fact: names, dates, times, places, what to bring, instructions and any call to action.\n'
        + '- Cut in this order, stopping as soon as it fits: filler and pleasantries that carry no facts ("just", "so much", "that"), '
        + 'then shorter words and common abbreviations ("&" for "and", "Sat", "pls", "4pm"), then tighter phrasing. '
        + 'Keep whole sentences readable; do not reduce it to a telegram or a list.\n'
        + '- Use most of the limit: a result well under it has cut too much.\n'
        + '- Use plain ASCII only: no emoji, no smart quotes, no dashes other than "-".\n'
        + (mustKeep.length ? `- Copy these tokens exactly, unchanged: ${mustKeep.join('  ')}\n` : '')
        + '- Reply with ONLY the edited message: no quotes, no commentary.',
    },
    { role: 'user', content: ask(EXAMPLE.message.length, 152) + EXAMPLE.message },
    { role: 'assistant', content: EXAMPLE.rewrite },
    { role: 'user', content: ask(length, ceiling) + message },
  ];
  if (feedback) {
    messages.push({ role: 'assistant', content: feedback.answer }, { role: 'user', content: feedback.text });
  }
  return messages;
}

/**
 * Call Workers AI and return the reply text.
 */
async function runModel(env, messages) {
  const reply = await env.AI.run(env.MODEL || DEFAULT_MODEL, {
    messages,
    max_tokens: 512,
    temperature: 0.2,
  });
  // Llama-style models answer { response }, OpenAI-style ones { choices }.
  return String(reply?.response ?? reply?.choices?.[0]?.message?.content ?? '');
}

// ---------------------------------------------------------------------------
// Segment maths (GSM 03.38 / UCS-2), matching jethro-sms's sms_statusline.php:
// GSM-7 messages hold 160 septets in one segment or 153 per segment when
// concatenated, the extension table (^{}\[~]|€ and form feed) costing 2
// septets; anything else forces UCS-2: 70 / 67 UTF-16 code units.
// ---------------------------------------------------------------------------

const GSM_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?'
  + '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
const GSM_EXTENSION = new Set('\f^{}\\[~]|€');

/**
 * @typedef {{encoding: 'GSM-7'|'UCS-2', length: number, segments: number}} SegmentInfo
 * length is in septets (GSM-7) or UTF-16 code units (UCS-2).
 */

/** @returns {SegmentInfo} */
export function segmentInfo(text) {
  let septets = 0;
  for (const ch of text) {
    if (GSM_BASIC.has(ch)) septets += 1;
    else if (GSM_EXTENSION.has(ch)) septets += 2;
    else {
      const length = text.length;
      return { encoding: 'UCS-2', length, segments: length <= 70 ? 1 : Math.ceil(length / 67) };
    }
  }
  return { encoding: 'GSM-7', length: septets, segments: septets <= 160 ? 1 : Math.ceil(septets / 153) };
}

/** Most GSM-7 septets that fit in $segments segments. */
export function gsmCapacity(segments) {
  return segments <= 1 ? 160 : segments * 153;
}

/**
 * Share of the text that must go for it to fit in $target segments, as a
 * GSM-7 rewrite: 0 when it already fits, 1/161 for 161 characters into 160.
 *
 * @param {SegmentInfo} info
 */
export function cutShare(info, target) {
  return Math.max(0, info.length - gsmCapacity(target)) / info.length;
}

/**
 * Replace typographic characters that force UCS-2 with GSM-7 equivalents,
 * and collapse runs of spaces.
 */
export function normalise(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u00A0\u2009\u202F]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Drop characters outside the GSM-7 alphabet (emoji, most non-Latin
 * letters), tidying the spaces they leave. Apply after normalise().
 */
export function stripNonGsm(text) {
  return [...text]
    .filter((ch) => GSM_BASIC.has(ch) || GSM_EXTENSION.has(ch))
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/ +([.,!?])/g, '$1')
    .trim();
}

/** Strip one pair of wrapping quotes a model may add around its answer. */
function stripQuotes(text) {
  const t = text.trim();
  const m = t.match(/^(["'`])([\s\S]*)\1$/);
  return m ? m[2] : t;
}

/**
 * Tokens a rewrite must keep verbatim: URLs, Jethro placeholders
 * (%word%, %word.word%, %(fn …)%) and phone numbers.
 */
export function protectedTokens(text) {
  const re = /https?:\/\/[^\s<>"]+|%\([^)]*\)%|%[A-Za-z_][\w.]*%|\+?\d[\d ]{6,}\d/g;
  return [...new Set(text.match(re) ?? [])];
}

// ---------------------------------------------------------------------------
// Auth: jethro.au API keys, checked by the jethro.au account Worker
// ---------------------------------------------------------------------------

/** Service id of this Worker in the jethro.au account's registry (SERVICES). */
const SERVICE_ID = 'sms-shortener';

/**
 * May the Bearer key use this service?
 *
 * The bootstrap env.API_KEY is accepted directly. Any other key is checked by
 * the jethro.au account Worker through the ACCOUNT service binding, which
 * requires the organisation's consent to this service: its 401 and 403
 * answers (e.g. { error: 'consent_required', service, privacyUrl }) are passed
 * through unchanged. Fails closed with 503 when the binding is missing or
 * gives anything else.
 *
 * @returns {Promise<{keyId: string|null} | {error: Response}>} keyId: the
 *   key's id at jethro.au (null for bootstrap keys), for rate limiting
 */
async function authorize(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { error: jsonResponse({ error: 'Unauthorized' }, 401) };
  }
  if (env.API_KEY && authHeader.slice(7) === env.API_KEY) {
    return { keyId: null };
  }
  const unavailable = () => ({ error: jsonResponse({ error: 'Authorization service unavailable' }, 503) });
  if (!env.ACCOUNT) {
    console.error('ACCOUNT service binding is missing');
    return unavailable();
  }

  let res, data;
  try {
    res = await env.ACCOUNT.fetch(new Request(`https://jethro.au/api/authorize?service=${SERVICE_ID}`, {
      headers: { Authorization: authHeader },
    }));
    data = await res.json();
  } catch (error) {
    console.error('jethro.au authorize failed:', error);
    return unavailable();
  }
  if (res.status === 200 && data?.authorized === true) {
    return { keyId: data.keyId ?? null };
  }
  if ((res.status === 401 || res.status === 403) && typeof data?.error === 'string') {
    return { error: jsonResponse(data, res.status) };
  }
  console.error(`jethro.au authorize answered ${res.status}:`, data);
  return unavailable();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
