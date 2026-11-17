/**
 * Tests for the SMS shortener Worker, run in Node with a fake Workers AI
 * binding and KV namespace (no Cloudflare account needed):
 *
 *   node test_worker.js
 *
 * Or against a deployed worker (real model calls, costs Neurons):
 *   BASE_URL=https://yourdomain.com API_KEY=your-key node test_worker.js
 */

import worker, { segmentInfo, normalise, protectedTokens, shortenMessage, gsmCapacity, cutShare } from './worker.js';

const BASE_URL = process.env.BASE_URL;
const API_KEY = process.env.API_KEY || 'test-key';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label} expected ${e}, got ${a}`);
}

const LONG = 'Hi %firstname%, a reminder that the working bee at the church hall is this Saturday from 8am '
  + 'until noon. Please bring gloves, a hat and water. Morning tea will be provided. '
  + 'Details: https://example.com/working-bee';

/** Fake Workers AI: answers each run() call with the next canned reply. */
function fakeAi(replies) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      return { response: replies[Math.min(calls.length - 1, replies.length - 1)] };
    },
  };
}

/** Fake KV holding one create-scoped key, stored as the URL shortener stores it. */
async function fakeKeyStore(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const data = {
    [`tok:${hash}`]: { id: 'k1' },
    'apikey:k1': { id: 'k1', type: 'create' },
  };
  return { async get(key) { return data[key] ?? null; } };
}

function post(body, token = API_KEY) {
  return new Request('https://example.com/api/sms-shorten', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function runUnitTests() {
  console.log('\n🧪 SMS shortener — unit tests\n');

  await test('GSM-7 segment boundaries are 160 then 153 per segment', () => {
    eq(segmentInfo('a'.repeat(160)), { encoding: 'GSM-7', length: 160, segments: 1 });
    eq(segmentInfo('a'.repeat(161)).segments, 2);
    eq(segmentInfo('a'.repeat(306)).segments, 2);
    eq(segmentInfo('a'.repeat(307)).segments, 3);
  });

  await test('extension characters cost two septets', () => {
    eq(segmentInfo('€'.repeat(80)), { encoding: 'GSM-7', length: 160, segments: 1 });
    eq(segmentInfo('€'.repeat(81)).segments, 2);
  });

  await test('one non-GSM character switches to UCS-2 (70 / 67)', () => {
    eq(segmentInfo('’' + 'a'.repeat(69)), { encoding: 'UCS-2', length: 70, segments: 1 });
    eq(segmentInfo('’' + 'a'.repeat(70)).segments, 2);
    eq(segmentInfo('😊').length, 2, 'emoji counts as a surrogate pair');
  });

  await test('normalise() maps typographic characters to GSM-7', () => {
    eq(normalise('“Don’t” – wait…  now'), '"Don\'t" - wait... now');
    eq(segmentInfo(normalise('It’s on')).encoding, 'GSM-7');
  });

  await test('protectedTokens() finds placeholders, URLs and phone numbers', () => {
    eq(
      protectedTokens('Hi %firstname% %selected.firstname% %(shorten "https://a.b/c")% see https://x.org/y or 0491 570 156'),
      ['%firstname%', '%selected.firstname%', '%(shorten "https://a.b/c")%', 'https://x.org/y', '0491 570 156'],
    );
  });

  await test('a message already within the target is returned without a model call', async () => {
    let calls = 0;
    const r = await shortenMessage('It’s on', null, async () => { calls++; return ''; });
    eq(calls, 0);
    eq(r.fits, true);
    eq(r.message, "It's on");
  });

  await test('normalising alone can drop a segment (UCS-2 → GSM-7)', async () => {
    const msg = 'It’s on ' + 'a'.repeat(100);
    eq(segmentInfo(msg).segments, 2);
    const r = await shortenMessage(msg, null, async () => { throw new Error('no model call expected'); });
    eq(r.fits, true);
    eq(r.result.segments, 1);
  });

  await test('the first rewrite that fits is returned', async () => {
    const short = 'Hi %firstname%, working bee Sat 8am-noon at the hall. Bring gloves, hat & water; morning tea provided. https://example.com/working-bee Thanks!';
    const r = await shortenMessage(LONG, null, async () => short);
    eq(r.fits, true);
    eq(r.attempts, 1);
    eq(r.message, short);
    eq(r.original.segments, 2);
    eq(r.result.segments, 1);
  });

  // 151 characters: within AIM_WINDOW of the first budget (160 - 8), so accepted as a minimal edit.
  const NEAR = 'Hi %firstname%, reminder: working bee at church hall Sat 8am-noon. Pls bring gloves, hat & water. Morning tea provided. https://example.com/working-bee';

  await test('a rewrite that drops a token is rejected and retried with feedback', async () => {
    const prompts = [];
    const replies = ['Working bee Sat 8am-noon, bring gloves!', NEAR];
    const r = await shortenMessage(LONG, null, async (m) => { prompts.push(m); return replies[prompts.length - 1]; });
    eq(r.attempts, 2);
    eq(r.message, NEAR);
    eq(prompts[1].at(-2), { role: 'assistant', content: replies[0] }, 'the retry shows the model its previous answer');
    assert(prompts[1].at(-1).content.includes('%firstname%'), 'feedback names the dropped token');
  });

  await test('a rewrite that is still too long is retried with a tighter budget', async () => {
    const prompts = [];
    const tooLong = 'Hi %firstname% ' + 'x'.repeat(170) + ' https://example.com/working-bee';
    const r = await shortenMessage(LONG, null, async (m) => { prompts.push(m); return prompts.length === 1 ? tooLong : NEAR; });
    eq(r.attempts, 2);
    eq(r.fits, true);
    const budget = (m) => Number(m[1].content.match(/and (\d+) characters/)[1]);
    assert(budget(prompts[1]) < budget(prompts[0]), 'second budget is smaller');
    assert(budget(prompts[0]) < gsmCapacity(1), 'budget leaves a margin');
  });

  await test('a rewrite that cuts far more than needed is retried, keeping more wording', async () => {
    const prompts = [];
    const overCut = 'Hi %firstname%, bee Sat. https://example.com/working-bee';
    const r = await shortenMessage(LONG, null, async (m) => { prompts.push(m); return prompts.length === 1 ? overCut : NEAR; });
    eq(r.attempts, 2);
    eq(r.message, NEAR);
    assert(prompts[1].at(-1).content.includes('cut more than needed'), 'feedback asks to keep more');
  });

  await test('if retries never land near the limit, the longest rewrite that fits wins', async () => {
    const replies = [
      'Hi %firstname%, bee Sat. https://example.com/working-bee',
      'Hi %firstname%, working bee Sat 8am-noon. https://example.com/working-bee',
      'Hi %firstname%. https://example.com/working-bee',
    ];
    let i = 0;
    const r = await shortenMessage(LONG, null, async () => replies[i++]);
    eq(r.attempts, 3);
    eq(r.fits, true);
    eq(r.message, replies[1]);
  });

  await test('emoji alone can force extra segments: dropping them needs no model call', async () => {
    const msg = 'a'.repeat(300) + ' 🙂';
    eq(segmentInfo(msg).segments, 5, 'UCS-2');
    const r = await shortenMessage(msg, null, async () => { throw new Error('no model call expected'); });
    eq(r.fits, true);
    eq(r.message, 'a'.repeat(300));
    eq(r.result.segments, 2);
  });

  await test('after dropping emoji, a rewrite aims one GSM-7 segment lower when the cut is small', async () => {
    const prompts = [];
    const msg = 'Hi %firstname%, ' + 'b'.repeat(170) + ' 🙂';
    const r = await shortenMessage(msg, null, async (m) => { prompts.push(m); return 'Hi %firstname%, ' + 'b'.repeat(130); });
    eq(r.target, 1);
    eq(r.fits, true);
    assert(prompts[0][1].content.startsWith('This message is 186 characters'), 'length counted without the emoji');
  });

  await test('a requested segment count is a maximum: a better target is used', async () => {
    const r = await shortenMessage('a'.repeat(300) + ' 🙂', 4, async () => { throw new Error('no model call expected'); });
    eq(r.target, 2);
    eq(r.result.segments, 2);
  });

  await test('when nothing fits, the shortest acceptable rewrite is returned with fits=false', async () => {
    const replies = [
      'Hi %firstname% ' + 'y'.repeat(200) + ' https://example.com/working-bee',
      'Hi %firstname% ' + 'z'.repeat(140) + ' https://example.com/working-bee',
      'no tokens at all',
    ];
    let i = 0;
    const r = await shortenMessage(LONG, null, async () => replies[i++]);
    eq(r.fits, false);
    eq(r.attempts, 3);
    eq(r.message, replies[1]);
  });

  await test('wrapping quotes are stripped from the model reply', async () => {
    const r = await shortenMessage(LONG, null, async () => '"Hi %firstname%, bee Sat. https://example.com/working-bee"');
    eq(r.message, 'Hi %firstname%, bee Sat. https://example.com/working-bee');
  });

  await test('an explicit segments target is honoured', async () => {
    const four = 'a'.repeat(400);
    const r = await shortenMessage(four, 2, async () => 'a'.repeat(300));
    eq(r.target, 2);
    eq(r.fits, true);
    eq(r.result.segments, 2);
  });

  await test('just over a boundary is worth a model call', async () => {
    let calls = 0;
    const r = await shortenMessage('a'.repeat(161), null, async () => { calls++; return 'a'.repeat(150); });
    eq(calls, 1);
    eq(r.fits, true);
  });

  await test('needing to cut more than 30% of the text skips the model', async () => {
    let calls = 0;
    const complete = async () => { calls++; return 'x'; };
    const r = await shortenMessage('a'.repeat(300), null, complete);
    eq(calls, 0);
    eq(r.fits, false);
    eq(r.attempts, 0);
    eq(r.message, 'a'.repeat(300));
    await shortenMessage('a'.repeat(400), 1, complete);
    eq(calls, 0, 'explicit targets are gated too');
    eq(cutShare(segmentInfo('a'.repeat(160 / 0.7)), 1) <= 0.3, true, '228 chars into 160 is allowed');
  });

  console.log('\n🧪 SMS shortener — fetch handler\n');

  const ai = fakeAi(['Hi %firstname%, bee Sat 8am. https://example.com/working-bee']);
  const env = { AI: ai, API_KEY: 'bootstrap-secret', API_KEYS: await fakeKeyStore('cus_good') };

  await test('missing or unknown key → 401', async () => {
    eq((await worker.fetch(post({ message: LONG }, 'cus_bad'), env)).status, 401);
    const noAuth = new Request('https://example.com/api/sms-shorten', { method: 'POST', body: '{}' });
    eq((await worker.fetch(noAuth, env)).status, 401);
  });

  await test('a URL-shortener create key is accepted', async () => {
    const res = await worker.fetch(post({ message: LONG }, 'cus_good'), env);
    eq(res.status, 200);
    const data = await res.json();
    eq(data.fits, true);
    eq(data.result.segments, 1);
    eq(ai.calls[0].model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  });

  await test('env.MODEL overrides the model', async () => {
    const ai2 = fakeAi(['Hi %firstname%, bee Sat. https://example.com/working-bee']);
    await worker.fetch(post({ message: LONG }, 'bootstrap-secret'), { ...env, AI: ai2, MODEL: '@cf/test/model' });
    eq(ai2.calls[0].model, '@cf/test/model');
  });

  await test('bad bodies → 400', async () => {
    eq((await worker.fetch(post({ message: '' }), { ...env, API_KEY: API_KEY })).status, 400);
    eq((await worker.fetch(post({ message: 'x'.repeat(2000) }), { ...env, API_KEY: API_KEY })).status, 400);
    eq((await worker.fetch(post({ message: LONG, segments: 0 }), { ...env, API_KEY: API_KEY })).status, 400);
  });

  await test('rate limiter refusal → 429', async () => {
    const limited = { ...env, RATE_LIMITER: { async limit() { return { success: false }; } } };
    eq((await worker.fetch(post({ message: LONG }, 'cus_good'), limited)).status, 429);
  });

  await test('a model failure → 502', async () => {
    const broken = { ...env, AI: { async run() { throw new Error('boom'); } } };
    eq((await worker.fetch(post({ message: LONG }, 'cus_good'), broken)).status, 502);
  });

  console.log('\n🧪 SMS shortener — privacy page\n');

  const privacy = (extraEnv = {}) => worker.fetch(new Request('https://example.com/sms-shortener/privacy'), { ...env, ...extraEnv });

  await test('the privacy page names the operator, contact, model maker and Cloudflare terms', async () => {
    const res = await privacy({ PRIVACY_OPERATOR: 'Example Ops', PRIVACY_CONTACT: 'privacy@example.com' });
    eq(res.status, 200);
    assert(res.headers.get('Content-Type').startsWith('text/html'), 'HTML');
    const html = await res.text();
    for (const needle of [
      'Example Ops', 'mailto:privacy@example.com', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'Meta Platforms, Inc.',
      'Llama 3.3 Community License', 'https://developers.cloudflare.com/workers-ai/platform/data-usage/',
      'https://www.cloudflare.com/privacypolicy/', 'outside Australia',
    ]) assert(html.includes(needle), `mentions ${needle}`);
  });

  await test('the privacy page names the model actually configured', async () => {
    const html = await (await privacy({ MODEL: '@cf/other/model' })).text();
    assert(html.includes('<code>@cf/other/model</code>'), 'names the configured model');
    assert(!html.includes('Meta Platforms'), 'does not claim the default model\'s maker');
  });

  await test('operator and contact are escaped', async () => {
    const html = await (await privacy({ PRIVACY_OPERATOR: '<b>X</b>', PRIVACY_CONTACT: 'a"b@example.com' })).text();
    assert(!html.includes('<b>X</b>') && html.includes('&lt;b&gt;X&lt;/b&gt;'), 'operator escaped');
    assert(html.includes('mailto:a&quot;b@example.com'), 'contact escaped');
  });
}

async function runLiveTests() {
  console.log(`\n🧪 SMS shortener — live tests against ${BASE_URL}\n`);

  await test('a two-segment message is reworded into one', async () => {
    const res = await fetch(`${BASE_URL}/api/sms-shorten`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ message: LONG }),
    });
    eq(res.status, 200);
    const data = await res.json();
    console.log(`     → ${data.message} (${data.result.length} chars, ${data.attempts} attempt(s))`);
    assert(data.message.includes('%firstname%'), 'placeholder kept');
    assert(data.message.includes('https://example.com/working-bee'), 'URL kept');
    eq(data.fits, true);
  });

  await test('missing key → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/sms-shorten`, { method: 'POST', body: '{}' });
    eq(res.status, 401);
  });
}

if (BASE_URL) await runLiveTests();
else await runUnitTests();

console.log(`\nPassed: ${passed}  Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
