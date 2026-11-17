#!/usr/bin/env php
<?php
// SPDX-License-Identifier: Apache-2.0
require_once __DIR__ . '/SmsShortener.php';
define('SMSSHORTENER', getenv('SMSSHORTENER') ?: 'jethroau');
define('SMSSHORTENER_API_KEY', getenv('SMSSHORTENER_API_KEY') ?: '');

if ($argc < 2) { fprintf(STDERR, "Usage: php src/php/shorten.php <message> [segments]\n"); exit(1); }
$message = $argv[1];
$segments = isset($argv[2]) ? (int)$argv[2] : null;
try {
	$r = getSmsShortener()->shorten($message, $segments);
	echo $r['message'] . "\n";
	fprintf(STDERR, "%d → %d segment(s), %s, %d attempt(s)\n",
		$r['original']['segments'], $r['result']['segments'], $r['fits'] ? 'fits' : 'does not fit', $r['attempts']);
}
catch (\RuntimeException $e) { fprintf(STDERR, "Error: %s\n", $e->getMessage()); exit(1); }
