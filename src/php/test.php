#!/usr/bin/env php
<?php
// SPDX-License-Identifier: Apache-2.0
/**
 * Live test of the PHP client against a deployed Worker (makes a real model
 * call). Needs JETHROAU_API_KEY (with the sms-shortener consent); SMSSHORTENER
 * defaults to jethroau.
 */
require_once __DIR__ . '/SmsShortener.php';

$opts = getopt('', ['apitoken:']);
$apiToken = $opts['apitoken'] ?? getenv('JETHROAU_API_KEY') ?: '';

define('SMSSHORTENER', getenv('SMSSHORTENER') ?: 'jethroau');
define('JETHROAU_API_KEY', $apiToken);

if ($apiToken === '') {
	fwrite(STDERR, "Error: no API key. Set JETHROAU_API_KEY env var or pass --apitoken.\n");
	exit(1);
}

const TEST_MESSAGE = 'Hi %firstname%, a reminder that the working bee at the church hall is this Saturday from 8am '
	. 'until noon. Please bring gloves, a hat and water. Morning tea will be provided. '
	. 'Details: https://example.com/working-bee';

$passed = 0; $failed = 0;
function pass($m) { global $passed; echo "  \u{2713} $m\n"; $passed++; }
function fail($m) { global $failed; echo "  \u{2717} $m\n"; $failed++; }

echo "Test 1: smsShortenerConfig()\n";
$c = smsShortenerConfig('jethroau');
$c['base'] === 'https://jethro.au' ? pass('jethroau → https://jethro.au') : fail("jethroau → {$c['base']}");
$c = smsShortenerConfig('');
!$c['configured'] && !$c['supported'] ? pass('blank is not configured') : fail('blank treated as configured');
$c = smsShortenerConfig('ftp://x');
$c['configured'] && !$c['supported'] ? pass('non-http URL is unsupported') : fail('ftp:// accepted');

echo "\nTest 2: a two-segment message is reworded into one\n";
try {
	$r = getSmsShortener()->shorten(TEST_MESSAGE);
	echo "  → {$r['message']}\n";
	$r['original']['segments'] === 2 ? pass('original is 2 segments') : fail("original is {$r['original']['segments']} segments");
	$r['fits'] && $r['result']['segments'] === 1 ? pass('result is 1 segment') : fail("result is {$r['result']['segments']} segments");
	str_contains($r['message'], '%firstname%') ? pass('placeholder kept') : fail('placeholder dropped');
	str_contains($r['message'], 'https://example.com/working-bee') ? pass('URL kept') : fail('URL dropped');
} catch (\RuntimeException $e) { fail("API error: {$e->getMessage()}"); }

echo "\n" . str_repeat("\u{2500}", 40) . "\nPassed: $passed  Failed: $failed\n";
exit($failed > 0 ? 1 : 0);
