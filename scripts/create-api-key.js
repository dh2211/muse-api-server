#!/usr/bin/env node
'use strict';

/**
 * Creates a client API key from the command line (useful for bootstrapping
 * before any admin tooling exists).
 *
 * Usage:
 *   npm run key:create -- --name "Acme Inc." [--scopes chat,images,videos,files] [--rpm 300] [--concurrency 20]
 *
 * The plaintext key and webhook secret are printed once and never stored.
 */

const mongoose = require('mongoose');
const config = require('../src/config');
const { ApiKey, SCOPES } = require('../src/models');
const { generateApiKey, generateWebhookSecret, sha256 } = require('../src/utils/crypto');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function fail(message) {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.name || args.name === true) {
    process.stdout.write('Usage: npm run key:create -- --name "Client name" [--scopes chat,images,videos,files] [--rpm 300] [--concurrency 20]\n');
    process.exit(args.help ? 0 : 1);
  }

  const scopes = args.scopes ? String(args.scopes).split(',').map((s) => s.trim()).filter(Boolean) : ['chat', 'images', 'videos', 'files'];
  const invalid = scopes.filter((s) => !SCOPES.includes(s));
  if (invalid.length) fail(`Unknown scope(s): ${invalid.join(', ')}. Valid scopes: ${SCOPES.join(', ')}.`);

  const rpm = args.rpm ? Number(args.rpm) : null;
  const concurrency = args.concurrency ? Number(args.concurrency) : null;
  if (rpm !== null && (!Number.isInteger(rpm) || rpm < 1)) fail('--rpm must be a positive integer.');
  if (concurrency !== null && (!Number.isInteger(concurrency) || concurrency < 1)) fail('--concurrency must be a positive integer.');

  await mongoose.connect(config.database.uri, { serverSelectionTimeoutMS: 10000 });
  const secret = generateApiKey();
  const webhookSecret = generateWebhookSecret();
  const doc = await ApiKey.create({
    name: String(args.name),
    key_hash: sha256(secret),
    key_prefix: `${secret.slice(0, 12)}...`,
    scopes,
    rate_limit_per_minute: rpm,
    max_concurrent_jobs: concurrency,
    webhook_secret: webhookSecret
  });
  await mongoose.disconnect();

  process.stdout.write([
    '',
    'API key created. Store these values securely - they will not be shown again.',
    '',
    `  id:             ${doc._id}`,
    `  name:           ${doc.name}`,
    `  scopes:         ${doc.scopes.join(', ')}`,
    `  api_key:        ${secret}`,
    `  webhook_secret: ${webhookSecret}`,
    ''
  ].join('\n') + '\n');
}

main().catch(async (err) => {
  await mongoose.disconnect().catch(() => {});
  fail(err.message);
});
