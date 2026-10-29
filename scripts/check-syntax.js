#!/usr/bin/env node
'use strict';

/**
 * Syntax-checks source, scripts, regression tests and browser JavaScript.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = ['src', 'scripts', 'tests', 'public'];

function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = TARGETS.flatMap((t) => collect(path.join(ROOT, t)));
let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed += 1;
    process.stderr.write(`\n[FAIL] ${path.relative(ROOT, file)}\n${result.stderr}`);
  }
}

process.stdout.write(`Checked ${files.length} files: ${files.length - failed} OK, ${failed} failed.\n`);
process.exit(failed ? 1 : 0);
