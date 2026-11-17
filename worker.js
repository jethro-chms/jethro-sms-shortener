/**
 * Cloudflare Worker - SMS shortener
 *
 * Rewords an SMS message so it fits in fewer SMS segments (e.g. 2 → 1, i.e.
 * ≤160 GSM-7 characters) while keeping its meaning. Used by Jethro's SMS
 * composer to offer a cheaper alternative for multi-recipient sends.
 *
 * Endpoints:
 *   POST /api/sms-shorten  { message: string, segments?: number }
 *     Authorization: Bearer <key>
 *   → 200 { message, fits, attempts, target, original: SegmentInfo, result: SegmentInfo }
 *   GET /sms-shortener/privacy  → the privacy page (privacy.js)
 *
 * The model (Workers AI) only proposes wording; this Worker counts segments
 * itself and retries with tighter budgets, because LLMs cannot count
 * characters reliably. Placeholder tokens (%firstname%, %(shorten "…")%),
 * URLs and phone numbers must survive the rewrite verbatim, or the attempt is
 * rejected.
 *
 * Keys are those of the jethro.au URL shortener: the API_KEYS binding is that
 * worker's KV namespace, read here only (tok:{sha256} → apikey:{id}). The
 * bootstrap env.API_KEY secret is also accepted.
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

/** Model calls per request: the first try plus retries with tighter budgets. */
export const MAX_ATTEMPTS = 3;

/**
 * Largest share of the text a rewrite may have to cut. Beyond it (e.g. 300
 * characters into 160) a rewording would lose meaning, so no model call is
 * made; just over a boundary (e.g. 161 characters) is always worth a try.
 */
export const MAX_CUT_SHARE = 0.3;

/**
 * How far under its character budget a rewrite may land and still count as a
 * minimal edit. Fitting rewrites shorter than that cut more than needed, so
 * the model is asked to keep more of the original wording.
 */
export const AIM_WINDOW = 20;

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
  const auth = await verifyApiKey(request, env);
  if (!auth.authorized) return jsonResponse({ error: 'Unauthorized' }, 401);

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
  const { message, segments } = body ?? {};
  if (typeof message !== 'string' || message.trim() === '') {
    return jsonResponse({ error: 'message must be a non-empty string' }, 400);
  }
  if (message.length > MAX_INPUT_LENGTH) {
    return jsonResponse({ error: `message must be at most ${MAX_INPUT_LENGTH} characters` }, 400);
  }
  if (segments !== undefined && !(Number.isInteger(segments) && segments >= 1)) {
    return jsonResponse({ error: 'segments must be a positive integer' }, 400);
  }

  try {
    const result = await shortenMessage(message, segments ?? null, (messages) => runModel(env, messages));
    return jsonResponse(result);
  } catch (error) {
    console.error('Model error:', error);
    return jsonResponse({ error: 'Model unavailable' }, 502);
  }
}

/**
 * Reword $message until it fits in $wanted segments (default: one fewer than
 * it uses now), or MAX_ATTEMPTS model calls have been made.
 *
 * The aim is the smallest edit that fits: a rewrite should land just under
 * the segment boundary, within AIM_WINDOW characters of its budget. A rewrite
 * that fits but cuts more than that (models readily summarise, dropping
 * details) is kept as a fallback and the model is asked again to keep more of
 * the original wording. Of the rewrites that fit, the longest wins.
 *
 * No model call is made when normalising alone fits, or when fitting would
 * mean cutting more than MAX_CUT_SHARE of the text ({@link cutShare}).
 *
 * Pure apart from the injected `complete(messages) → Promise<string>`, so it
 * is testable without Workers AI.
 *
 * @returns {Promise<{message: string, fits: boolean, attempts: number, target: number,
 *   original: SegmentInfo, result: SegmentInfo}>}
 *   message: the longest rewrite that fits, else the shortest acceptable one
 *   (the normalised input when no attempt was shorter); fits: result.segments <= target.
 */
export async function shortenMessage(message, wanted, complete) {
  const original = segmentInfo(message);
  const cleaned = normalise(message);
  const before = segmentInfo(cleaned);

  if (before.segments === 1 || (wanted != null && before.segments <= wanted)) {
    return { message: cleaned, fits: true, attempts: 0, target: wanted ?? 1, original, result: before };
  }

  // Rewrites are GSM-7, so start from the text without emoji and other
  // non-GSM characters: dropping them alone may save several segments (a
  // UCS-2 segment holds 70 characters, a GSM-7 one 160). Then aim one
  // segment lower when that needs at most MAX_CUT_SHARE cut. A requested
  // target is a maximum: a better one is used when available.
  const plainText = stripNonGsm(cleaned);
  const plain = segmentInfo(plainText);
  const best = plain.segments > 1 && cutShare(plain, plain.segments - 1) <= MAX_CUT_SHARE ? plain.segments - 1 : plain.segments;
  const target = wanted != null && wanted < best ? wanted : best;

  if (target >= before.segments) {
    return { message: cleaned, fits: false, attempts: 0, target: before.segments - 1, original, result: before };
  }
  const mustKeep = protectedTokens(cleaned);
  if (plain.segments <= target && mustKeep.every((t) => plainText.includes(t))) {
    return { message: plainText, fits: true, attempts: 0, target, original, result: plain };
  }
  if (cutShare(plain, target) > MAX_CUT_SHARE) {
    return { message: cleaned, fits: false, attempts: 0, target, original, result: before };
  }

  // Rewrites are plain ASCII, so budget against GSM-7 capacity, minus a
  // margin because models overshoot length limits.
  const limit = gsmCapacity(target);
  let fit = null;             // longest acceptable rewrite that fits
  let fallback = plainText;   // shortest acceptable rewrite, when none fits
  let fallbackInfo = plain;
  let feedback = null;
  let margin = 8;
  let attempt = 0;

  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    const budget = limit - margin;
    const out = normalise(stripQuotes(await complete(buildPrompt(cleaned, plain.length, budget, mustKeep, feedback))));
    const info = segmentInfo(out);
    const lost = mustKeep.filter((t) => !out.includes(t));
    const acceptable = out !== '' && lost.length === 0;

    if (acceptable && info.segments <= target) {
      if (!fit || info.length > fit.info.length) fit = { out, info };
      if (info.length >= budget - AIM_WINDOW) break;
      feedback = { answer: out, text: `That fits, but at ${info.length} characters it cut more than needed. Start again from the original `
        + `message and keep more of its wording and details, aiming for ${budget - AIM_WINDOW} to ${budget} characters.` };
      continue;
    }
    if (acceptable && info.length < fallbackInfo.length) {
      fallback = out;
      fallbackInfo = info;
    }
    margin += 10;
    feedback = { answer: out, text: lost.length
      ? `You dropped required tokens: ${lost.join('  ')}. Include each exactly as written.`
      : `That was ${info.length} characters; it must be at most ${limit - margin}. Shorten it further.` };
  }
  return fit
    ? { message: fit.out, fits: true, attempts: attempt, target, original, result: fit.info }
    : { message: fallback, fits: false, attempts: attempt, target, original, result: fallbackInfo };
}

/**
 * Chat messages asking the model for one rewrite of $message, $length
 * characters as plain GSM-7, in at most $budget characters and as close to
 * it as possible.
 *
 * @param {{answer: string, text: string} | null} feedback  the previous
 *   answer and what was wrong with it, for a retry
 */
export function buildPrompt(message, length, budget, mustKeep, feedback) {
  const messages = [
    {
      role: 'system',
      content:
        'You shorten SMS messages sent by a church to its members by making the smallest edits that fit the length limit. '
        + 'Keep the original wording, order and tone wherever you can, and every piece of information: '
        + 'names, dates, times, places, instructions and any call to action. '
        + 'Cut in this order, stopping as soon as the message fits: filler words and pleasantries ("just", "so much", "that"), '
        + 'then common abbreviations ("&" for "and", "Sat", "pls", "8am"), then tighter phrasing. Drop information only as a last resort. '
        + 'The result should be close to the limit, not much shorter. '
        + 'Use plain ASCII only: no emoji, no smart quotes, no dashes other than "-". Stay readable and polite. '
        + (mustKeep.length ? `Copy these tokens exactly, unchanged: ${mustKeep.join('  ')}. ` : '')
        + 'Reply with ONLY the rewritten message: no quotes, no commentary.',
    },
    {
      role: 'user',
      content: `This message is ${length} characters. Shorten it to between ${budget - AIM_WINDOW} and ${budget} characters `
        + `(remove about ${length - budget + AIM_WINDOW / 2} characters):\n\n${message}`,
    },
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
// Auth: keys from the jethro.au URL shortener's KV store
// ---------------------------------------------------------------------------

/**
 * Verify the Bearer token. Returns { authorized, keyId? }.
 *
 * Accepts the bootstrap env.API_KEY, or any admin/create key in the API_KEYS
 * namespace (looked up O(1) by SHA-256 of the token).
 */
async function verifyApiKey(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { authorized: false };
  }
  const token = authHeader.slice(7);

  if (env.API_KEY && token === env.API_KEY) {
    return { authorized: true };
  }
  if (!env.API_KEYS) return { authorized: false };

  const tokenHash = await sha256Hex(token);
  const tokRef = await env.API_KEYS.get(`tok:${tokenHash}`, { type: 'json' });
  if (tokRef && tokRef.id) {
    const keyData = await env.API_KEYS.get(`apikey:${tokRef.id}`, { type: 'json' });
    if (keyData && (keyData.type === 'admin' || keyData.type === 'create')) {
      return { authorized: true, keyId: keyData.id };
    }
  }
  return { authorized: false };
}

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
