<?php
// SPDX-License-Identifier: Apache-2.0
/**
 * SMS shortener client: asks the jethro.au SMS shortener Worker to reword a
 * message so it fits in fewer SMS segments.
 *
 * The Worker counts segments itself (GSM-7 160/153, UCS-2 70/67) and only
 * returns rewrites that keep every %placeholder%, URL and phone number of the
 * original. Callers should still re-count with their own segment maths before
 * offering the result, since that is what they will be billed by.
 *
 * The API key is the installation's jethro.au key (constant JETHROAU_API_KEY),
 * shared with the other jethro.au services. The service also needs the
 * organisation's consent to it, recorded at jethro.au (see the jethro.au URL
 * shortener's PHP_INTEGRATION.md); without it every call fails with
 * "SMS shortener: API error (consent_required)" (or consent_outdated).
 */

interface SmsShortener
{
	/**
	 * Reword $message to fit in $segments segments, or fewer.
	 *
	 * @param int|null $segments most segments wanted; null = one fewer than $message uses.
	 *        The service may aim lower, e.g. when dropping emoji (which force UCS-2) saves more.
	 * @param float|null $maxCut largest share of the text (0 to 1) a rewrite may cut; beyond it the
	 *        service returns $message unchanged without asking the model. 1 = always try;
	 *        null = the service's default (0.3).
	 * @return array{message: string, fits: bool, attempts: int, target: int,
	 *               original: array{encoding: string, length: int, segments: int},
	 *               result: array{encoding: string, length: int, segments: int}}
	 *         message: the longest rewrite that fits target (a minimal edit of $message),
	 *         else the shortest acceptable one; fits: result.segments <= target
	 * @throws \RuntimeException on network or API errors. The message names the API's error
	 *         code, e.g. "SMS shortener: API error (consent_required)" when the organisation
	 *         has not agreed to the service (HTTP 403; also consent_outdated, Unauthorized).
	 */
	public function shorten(string $message, ?int $segments = null, ?float $maxCut = null): array;
}

class JethroAuSmsShortener implements SmsShortener
{
	/**
	 * @param int $timeout seconds for the whole request. Rewordings usually take
	 *        2-6 s; a hung service must not tie up a PHP worker for long, as callers
	 *        such as Jethro's composer may make one request per typing pause.
	 */
	public function __construct(
		private string $apiKey,
		private string $endpoint = 'https://jethro.au/api/sms-shorten',
		private int $timeout = 12,
	) {}

	public function shorten(string $message, ?int $segments = null, ?float $maxCut = null): array
	{
		$payload = ['message' => $message];
		if ($segments !== null) $payload['segments'] = $segments;
		if ($maxCut !== null) $payload['max_cut'] = max(0.0, min(1.0, $maxCut));

		$ch = curl_init($this->endpoint);
		curl_setopt_array($ch, [
			CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true,
			CURLOPT_HTTPHEADER => ["Authorization: Bearer {$this->apiKey}", 'Content-Type: application/json'],
			CURLOPT_POSTFIELDS => json_encode($payload),
			CURLOPT_TIMEOUT => $this->timeout,
			// An unreachable service fails in seconds rather than the full timeout.
			CURLOPT_CONNECTTIMEOUT => min(3, $this->timeout),
		]);
		$body = curl_exec($ch);
		$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
		$error = curl_error($ch);
		if ($error) throw new \RuntimeException("SMS shortener: network error ($error)");

		$data = json_decode((string)$body, true);
		if ($httpCode !== 200 || !is_array($data) || !isset($data['message']) || !is_string($data['message']))
			throw new \RuntimeException('SMS shortener: API error (' . ($data['error'] ?? "HTTP $httpCode") . ')');
		foreach (['original', 'result'] as $k) {
			if (!isset($data[$k]['segments']) || !is_int($data[$k]['segments']))
				throw new \RuntimeException("SMS shortener: invalid response ($k)");
		}
		return [
			'message' => $data['message'],
			'fits' => (bool)($data['fits'] ?? false),
			'attempts' => (int)($data['attempts'] ?? 0),
			'target' => (int)($data['target'] ?? 0),
			'original' => $data['original'],
			'result' => $data['result'],
		];
	}
}

/**
 * The configured SMS shortener (memoized), using the installation's jethro.au
 * API key from the JETHROAU_API_KEY constant ('' when undefined).
 *
 * @throws \RuntimeException when SMSSHORTENER is blank or not a URL
 */
function getSmsShortener(): SmsShortener
{
	static $shortener = null;
	if ($shortener !== null) return $shortener;
	$config = smsShortenerConfig();
	if (!$config['supported']) {
		throw new \RuntimeException($config['configured']
			? "Unsupported SMSSHORTENER: {$config['raw']}. Use 'jethroau' or an http(s) base URL."
			: 'SMSSHORTENER not configured');
	}
	return $shortener = new JethroAuSmsShortener(
		apiKey: defined('JETHROAU_API_KEY') ? (string) JETHROAU_API_KEY : '',
		endpoint: $config['base'] . '/api/sms-shorten',
	);
}

/**
 * Interpret the SMSSHORTENER setting: the base URL of the Worker.
 *
 * 'jethroau' is an alias for https://jethro.au, which is also the default
 * when SMSSHORTENER is undefined. Any other http(s) URL names a self-hosted
 * Worker (or a test double). Blank means "not configured".
 *
 * @return array{raw: string, configured: bool, supported: bool, base: string, privacy: string}
 *         raw: the setting as written; configured: not blank; supported: usable;
 *         base: service URL without trailing slash ('' when blank or unsupported);
 *         privacy: the service's privacy page, which says who sees message text
 *         ('' when unsupported). Show it to anyone deciding to turn the service on.
 */
function smsShortenerConfig(?string $setting = null): array
{
	$raw = trim($setting ?? (defined('SMSSHORTENER') ? (string) SMSSHORTENER : 'https://jethro.au'));
	$key = rtrim($raw, '/');
	$base = '';
	if (strcasecmp($key, 'jethroau') === 0) {
		$base = 'https://jethro.au';
	} elseif (preg_match('#^https?://[^/\s]+(/\S*)?$#i', $key)) {
		$base = $key;
	}
	return [
		'raw' => $raw,
		'configured' => $key !== '',
		'supported' => $base !== '',
		'base' => $base,
		'privacy' => $base !== '' ? $base . '/sms-shortener/privacy' : '',
	];
}
