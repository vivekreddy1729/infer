#!/usr/bin/env node
/**
 * Enforce that carrier adapters stay independent of each other.
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION
 *
 * The Progressive adapter is verified working end-to-end against a real account.
 * That is the most expensive artefact in this repository — it took most of the
 * engineering log to produce — and the cheapest way to lose it is for someone
 * adding a second carrier to "just reuse" a Progressive helper, or to nudge a
 * shared base class to suit a new portal.
 *
 * Duplication between adapters is therefore a deliberate, accepted cost. This
 * check makes that decision structural instead of a comment nobody reads.
 *
 * WHAT IT ALLOWS
 *   - extending BaseCarrier and using its shared primitives
 *   - importing genuinely carrier-agnostic infrastructure (config, logger)
 *   - a carrier importing its own files
 *
 * WHAT IT FORBIDS
 *   - one carrier importing another, in either direction
 *   - a carrier-specific token appearing in shared core code, which is how
 *     `if (carrierId === 'progressive')` branches creep in
 *
 * NOTE ON THIS TOOL'S OWN HISTORY: the first version of this check was a grep
 * for the string "progressive" in the GEICO directory. It reported a violation
 * for every file, because each one carries a comment saying "FORBIDDEN importing
 * anything from progressive.js". A checker that flags the documentation of a rule
 * as a breach of that rule is exactly the failure pattern the engineering log
 * keeps recording (F-06, F-14, F-25, F-32). It now parses import statements
 * rather than searching text, and has a negative control below.
 *
 *   node tools/check-carrier-isolation.js
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const CARRIERS_DIR = 'src/carriers';
const SHARED_DIRS = ['src/session', 'src/browser', 'src/storage', 'src/telemetry', 'src/logging'];

/** Files the contract explicitly permits every adapter to depend on. */
const SHARED_ALLOWED = new Set(['baseCarrier.js', 'registry.js']);

/**
 * Real import statements only. Anchored to line start and to the import/require
 * keywords, so prose mentioning a filename is not a match.
 */
const IMPORT_RE = /^\s*(?:import\b[^;'"]*?from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/gm;

function importsOf(source) {
  return [...source.matchAll(IMPORT_RE)].map((m) => m[1]);
}

async function listJs(dir) {
  const out = [];
  async function walk(d) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.js')) out.push(p);
    }
  }
  await walk(dir);
  return out;
}

/**
 * Identify each adapter and the token that identifies it.
 *
 * Derived from the filesystem rather than hardcoded, so a third carrier is
 * covered the moment it is added and nobody has to remember to update this list.
 */
async function discoverCarriers() {
  const entries = await readdir(CARRIERS_DIR, { withFileTypes: true });
  const carriers = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      carriers.push({ token: e.name, root: path.join(CARRIERS_DIR, e.name) });
    } else if (e.name.endsWith('.js') && !SHARED_ALLOWED.has(e.name)) {
      carriers.push({ token: e.name.replace(/(Carrier)?\.js$/, '').toLowerCase(), root: path.join(CARRIERS_DIR, e.name) });
    }
  }
  return carriers;
}

let failures = 0;
const pass = (msg, detail = '') => console.log(`  PASS  ${msg}${detail ? `  ${detail}` : ''}`);
const fail = (msg, detail = '') => {
  failures += 1;
  console.log(`  FAIL  ${msg}${detail ? `  ${detail}` : ''}`);
};

async function main() {
  console.log('Carrier isolation check\n');

  const carriers = await discoverCarriers();
  console.log(`  discovered ${carriers.length} adapter(s): ${carriers.map((c) => c.token).join(', ')}\n`);

  // -- 1. No adapter may import another -----------------------------------
  for (const c of carriers) {
    const isDir = (await stat(c.root)).isDirectory();
    const files = isDir ? await listJs(c.root) : [c.root];
    const others = carriers.filter((o) => o.token !== c.token);
    let violations = [];

    for (const f of files) {
      const src = await readFile(f, 'utf8');
      for (const spec of importsOf(src)) {
        // A carrier importing its own directory is fine.
        if (isDir && (spec.startsWith('./') || spec.startsWith('../' + c.token))) continue;
        for (const o of others) {
          // Match the path segment, not a substring of prose.
          const segs = spec.toLowerCase().split(/[/\\]/).map((s) => s.replace(/\.js$/, ''));
          if (segs.includes(o.token) || segs.includes(`${o.token}carrier`)) {
            violations.push(`${f} imports ${spec}`);
          }
        }
      }
    }

    if (violations.length) fail(`${c.token} imports another carrier`, `\n        ${violations.join('\n        ')}`);
    else pass(`${c.token} imports no other carrier`, `(${files.length} file(s))`);
  }

  // -- 2. Shared core must not branch on a specific carrier ----------------
  console.log('');
  for (const dir of SHARED_DIRS) {
    const files = await listJs(dir);
    const hits = [];
    for (const f of files) {
      const src = await readFile(f, 'utf8');
      // Strip comments: a comment naming a carrier is explanation, not coupling.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const c of carriers) {
        // A quoted carrier id in executable code is the branch we care about.
        const re = new RegExp(`['"\`]${c.token}['"\`]`, 'i');
        if (re.test(code)) hits.push(`${f} references '${c.token}' in executable code`);
      }
    }
    if (hits.length) fail(`${dir} branches on a carrier id`, `\n        ${hits.join('\n        ')}`);
    else pass(`${dir} is carrier-agnostic`, `(${files.length} file(s))`);
  }

  // -- 3. Negative control -------------------------------------------------
  /**
   * A test that cannot fail is not a test. This proves the import parser
   * actually detects a violation, and — critically — that it does NOT fire on a
   * comment mentioning the same path, which is the bug the first version had.
   */
  console.log('');
  const planted = `
import BaseCarrier from '../baseCarrier.js';
import helper from '../progressive.js';
`;
  const commentOnly = `
/** FORBIDDEN: importing anything from ../progressive.js */
// do not import ../progressive.js
import BaseCarrier from '../baseCarrier.js';
`;
  const detects = importsOf(planted).some((s) => s.includes('progressive'));
  const falsePositive = importsOf(commentOnly).some((s) => s.includes('progressive'));

  if (detects) pass('parser detects a planted cross-carrier import');
  else fail('parser did NOT detect a planted import — this check is worthless');

  if (!falsePositive) pass('parser ignores a comment mentioning the same path');
  else fail('parser flags a comment as an import (the original bug)');

  console.log('');
  if (failures) {
    console.log(`${failures} ISOLATION CHECK(S) FAILED`);
    console.log('Adapters must stay independent. Duplication between carriers is the accepted cost;');
    console.log('see the contract in src/carriers/geico/selectors.js.');
    process.exit(1);
  }
  console.log('ALL ISOLATION CHECKS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
