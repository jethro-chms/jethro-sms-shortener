/**
 * The SMS shortener's privacy page, served at GET /sms-shortener/privacy.
 *
 * Static apart from the operator, the contact address (env.PRIVACY_OPERATOR,
 * env.PRIVACY_CONTACT) and the model in use (env.MODEL), so the page always
 * names the model that actually sees the text. Jethro links to it from the
 * SMS Shortening registration form, and the jethro.au signup page and
 * magic-link email link to it for SMS shortener signups.
 *
 * Facts about Cloudflare come from its Workers AI data-usage page
 * (https://developers.cloudflare.com/workers-ai/platform/data-usage/) and
 * model catalogue; re-check them when changing the model.
 */

/** Path of the privacy page. */
export const PRIVACY_PATH = '/sms-shortener/privacy';

/** Date the page text was last changed. */
const LAST_UPDATED = '17 November 2026';

/**
 * Who made each model, and its licence, for models this page has been
 * checked against. Others are described generically.
 */
const MODELS = {
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': {
    name: 'Llama 3.3 70B Instruct',
    maker: 'Meta Platforms, Inc.',
    licence: 'Llama 3.3 Community License',
    licenceUrl: 'https://github.com/meta-llama/llama-models/blob/main/models/llama3_3/LICENSE',
  },
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * Render the privacy page.
 *
 * @param {{PRIVACY_OPERATOR?: string, PRIVACY_CONTACT?: string}} env
 * @param {string} model  Workers AI model ID in use
 * @returns {string} HTML document
 */
export function privacyPage(env, model) {
  const operator = escapeHtml(env.PRIVACY_OPERATOR || 'the operator of this service');
  const contact = env.PRIVACY_CONTACT
    ? `<a href="mailto:${escapeHtml(env.PRIVACY_CONTACT)}">${escapeHtml(env.PRIVACY_CONTACT)}</a>`
    : 'the operator';
  const info = MODELS[model];
  const modelId = `<code>${escapeHtml(model)}</code>`;
  const modelText = info
    ? `<p>The model is ${modelId}: ${escapeHtml(info.name)}, created by ${escapeHtml(info.maker)} and licensed under the
      <a href="${escapeHtml(info.licenceUrl)}">${escapeHtml(info.licence)}</a>. It is hosted and run by Cloudflare on
      Cloudflare's own network ("Cloudflare-hosted" in Cloudflare's
      <a href="https://developers.cloudflare.com/workers-ai/models/">model catalogue</a>).
      ${escapeHtml(info.maker.replace(/,? Inc\.$/, ''))} does not receive your messages: it supplied the model, not the service running it.</p>`
    : `<p>The model is ${modelId}, run by Cloudflare. Its maker and licence are listed in Cloudflare's
      <a href="https://developers.cloudflare.com/workers-ai/models/">model catalogue</a>.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>jethro.au SMS shortener: privacy</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 46em; margin: 2em auto; padding: 0 1em; line-height: 1.5; color: #222; }
  h1 { font-size: 1.6em; } h2 { font-size: 1.2em; margin-top: 1.6em; }
  code { background: #f3f3f3; padding: 0 0.2em; }
  .summary { background: #f5f8fc; border-left: 4px solid #3a6ea5; padding: 0.6em 1em; }
</style>
</head>
<body>
<h1>jethro.au SMS shortener: privacy</h1>
<p><em>Last updated ${LAST_UPDATED}.</em></p>

<div class="summary">
<p><strong>In short:</strong> when the SMS shortener is turned on, the text of an SMS being written in Jethro is sent to
jethro.au, and from there to Cloudflare's Workers AI service, which runs an AI model to suggest a shorter wording.
Neither this service nor Cloudflare keeps the text after answering, and Cloudflare does not use it to train models.
Don't use the feature for messages containing information you would not share with these providers.</p>
</div>

<h2>Who runs this service</h2>
<p>The SMS shortener at jethro.au is operated by ${operator}. Questions, requests and complaints about privacy:
${contact}.</p>
<p>It is optional. It only works once a Jethro administrator has registered an API key for it, in the
<em>SMS Shortening</em> section of Jethro's System Configuration. Its source code is public:
<a href="https://github.com/jethro-chms/jethro-sms-shortener">github.com/jethro-chms/jethro-sms-shortener</a>.</p>

<h2>What is sent, and when</h2>
<p>Jethro sends a request only when someone is writing an SMS to more than one person and the message is longer than
one SMS segment (160 characters): when they stop typing for 3 seconds, change who it is going to, or ask for a shorter
or longer suggestion. Jethro remembers each user's recent suggestions, so asking again for one does not resend the
text. The request contains:</p>
<ul>
  <li>the message text as typed, with placeholders such as <code>%firstname%</code> not yet filled in, so recipients'
    names are not included unless they were typed into the message;</li>
  <li>the number of SMS segments to aim for;</li>
  <li>your Jethro site's API key.</li>
</ul>
<p>Recipients' names, phone numbers and other details from Jethro are <strong>not</strong> sent. The request travels
over HTTPS.</p>

<h2>Who sees the message text</h2>
<p><strong>1. This service.</strong> The jethro.au SMS shortener is a Cloudflare Worker. It passes the text to the
AI model, checks the answer's length, and returns the suggestion to your Jethro site. It does not store or log message
text. It counts requests per API key to limit usage.</p>

<p><strong>2. Cloudflare Workers AI.</strong> Cloudflare, Inc. runs the AI model that rewords the text. Cloudflare's
<a href="https://developers.cloudflare.com/workers-ai/platform/data-usage/">Workers AI data-usage commitments</a>
state that, for requests like these:</p>
<ul>
  <li><strong>zero data retention:</strong> inputs and outputs are not kept after the request has been answered,
    apart from limited safety, security and legal exceptions;</li>
  <li><strong>no training:</strong> Cloudflare does not use them to train AI models;</li>
  <li>they are not made available to other Cloudflare customers;</li>
  <li>Cloudflare keeps operational metadata (such as timestamps, request sizes, token counts and error codes),
    which does not include the text.</li>
</ul>
<p>Cloudflare's handling of personal information is described in its
<a href="https://www.cloudflare.com/privacypolicy/">Privacy Policy</a>. Cloudflare runs a global network, so the
text may be processed in a data centre outside Australia.</p>

${modelText}

<p><strong>3. Nobody else.</strong> The text is not sent to any other AI provider or third party, and is not passed
through an AI gateway or cache.</p>

<p><strong>The suggestion</strong> is returned to your Jethro site and shown to the person writing the SMS. It is only
used if they choose <em>Use instead?</em>; the SMS is then sent by your own SMS provider, as usual.</p>

<h2>Registration details</h2>
<p>SMS shortener API keys are jethro.au API keys, shared with the jethro.au URL shortener. Registering stores the key
(as a one-way hash), the email address or Google/GitHub account you signed in with, and your organisation's name
as given by Jethro. Sign-in links sent by email are delivered through the email service Resend. An administrator
can revoke the key with <em>Deregister</em> in Jethro, or by contacting us.</p>

<h2>Your choices</h2>
<ul>
  <li>People writing SMSes can simply ignore suggestions, but the text has already been sent by then.</li>
  <li>Administrators can turn the feature off with <em>Deregister</em> in Jethro's <em>SMS Shortening</em> settings,
    or by clearing <code>SMSSHORTENER_API_KEY</code>.</li>
  <li>Organisations that send sensitive information by SMS (pastoral care, health, safeguarding) should consider
    leaving the feature off.</li>
</ul>

<h2>Changes</h2>
<p>If this page changes, the date at the top changes too. Material changes, such as using a different AI provider,
will be described here.</p>
</body>
</html>`;
}
