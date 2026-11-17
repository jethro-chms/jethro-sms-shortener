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
 */

interface SmsShortener
{
	/**
	 * Reword $message to fit in $segments segments, or fewer.
	 *
	 * @param int|null $segments most segments wanted; null = one fewer than $message uses.
	 *        The service may aim lower, e.g. when dropping emoji (which force UCS-2) saves more.
	 * @return array{message: string, fits: bool, attempts: int, target: int,
	 *               original: array{encoding: string, length: int, segments: int},
	 *               result: array{encoding: string, length: int, segments: int}}
	 *         message: the longest rewrite that fits target (a minimal edit of $message),
	 *         else the shortest acceptable one; fits: result.segments <= target
	 * @throws \RuntimeException on network or API errors
	 */
	public function shorten(string $message, ?int $segments = null): array;
}

class JethroAuSmsShortener implements SmsShortener
{
	public function __construct(
		private string $apiKey,
		private string $endpoint = 'https://jethro.au/api/sms-shorten',
		private int $timeout = 20,
	) {}

	public function shorten(string $message, ?int $segments = null): array
	{
		$payload = ['message' => $message];
		if ($segments !== null) $payload['segments'] = $segments;

		$ch = curl_init($this->endpoint);
		curl_setopt_array($ch, [
			CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true,
			CURLOPT_HTTPHEADER => ["Authorization: Bearer {$this->apiKey}", 'Content-Type: application/json'],
			CURLOPT_POSTFIELDS => json_encode($payload),
			CURLOPT_TIMEOUT => $this->timeout,
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
 * The configured SMS shortener (memoized).
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
		apiKey: defined('SMSSHORTENER_API_KEY') ? (string) SMSSHORTENER_API_KEY : '',
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
