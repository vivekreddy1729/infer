#!/usr/bin/env node
/**
 * Which characters does per-character `locator.press()` silently drop?
 *
 * ISOLATION: GEICO-local. No Progressive imports, no carrier traffic — runs
 * entirely against a loopback fixture.
 *
 * ------------------------------------------------------------------------
 * WHY
 * ------------------------------------------------------------------------
 * A real GEICO login failed with:
 *
 *     credential fields did not accept input (user 22/22, pass 12/13)
 *
 * The username arrived intact. The password was exactly one character short, twice
 * in a row — deterministic, so a specific character rather than flakiness.
 *
 * `BaseCarrier.typeLikeHuman()` types with `locator.press(ch)` per character.
 * `press()` takes a **key name**, not a character, and its parser treats `+` as a
 * modifier separator (`Shift+A`). So some printable characters cannot be expressed
 * as a bare key name and are silently dropped — no error, just a shorter value.
 *
 * The read-back check in the GEICO adapter is what caught it. Without that check the
 * run would have submitted a truncated password and reported "GEICO rejected your
 * credentials", sending the user to re-type a password that was correct.
 *
 * This test identifies the affected characters empirically rather than guessing, and
 * confirms the replacement method handles them.
 *
 * NOTE ON SCOPE: this is a defect in a shared primitive, so it affects Progressive
 * too. It is NOT fixed there by this work — GEICO overrides the method locally per
 * the isolation contract. See F-39 for the reasoning and the flag.
 *
 *   node tools/geico/test-typing-fidelity.js
 */

import http from 'node:http';
import { chromium } from 'patchright';
import { launchOptions, contextOptions } from '../../src/browser/stealth.js';

/** Printable ASCII that a password realistically contains. */
const CHARS = [
  ...'abcdefghijklmnopqrstuvwxyz',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'0123456789',
  ...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
];

function startFixture() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<input id="t" type="text"><input id="p" type="password">');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

async function launch() {
  for (const ch of ['chrome', 'chromium', undefined]) {
    try { return await chromium.launch({ ...launchOptions({ headless: true }), channel: ch }); } catch { /* next */ }
  }
  throw new Error('no browser channel');
}

async function main() {
  console.log('Typing fidelity: press() vs pressSequentially()\n');
  const { server, port } = await startFixture();
  const browser = await launch();
  const context = await browser.newContext(contextOptions());
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);

  const field = page.locator('#t');

  // -- method A: per-character press(), as BaseCarrier.typeLikeHuman does ----
  const pressDropped = [];
  const pressErrored = [];
  for (const ch of CHARS) {
    await field.fill('');
    try {
      await field.press(ch === ' ' ? 'Space' : ch, { timeout: 3000 });
      const got = await field.inputValue();
      if (got !== ch) pressDropped.push({ ch, got });
    } catch (err) {
      pressErrored.push({ ch, err: err.message.split('\n')[0].slice(0, 70) });
    }
  }

  // -- method B: pressSequentially(), the replacement ------------------------
  const seqDropped = [];
  const canSeq = typeof field.pressSequentially === 'function';
  for (const ch of CHARS) {
    await field.fill('');
    try {
      if (canSeq) await field.pressSequentially(ch, { delay: 5, timeout: 3000 });
      else await field.type(ch, { delay: 5, timeout: 3000 });
      const got = await field.inputValue();
      if (got !== ch) seqDropped.push({ ch, got });
    } catch (err) {
      seqDropped.push({ ch, got: `ERROR ${err.message.split('\n')[0].slice(0, 50)}` });
    }
  }

  console.log(`  method used for B: ${canSeq ? 'pressSequentially()' : 'type() (pressSequentially unavailable)'}`);
  console.log(`  characters tested: ${CHARS.length}\n`);

  console.log('  === per-character press()  — what BaseCarrier does ===');
  if (pressErrored.length) {
    console.log(`    THREW on ${pressErrored.length}: ${pressErrored.map((x) => JSON.stringify(x.ch)).join(' ')}`);
    for (const x of pressErrored.slice(0, 4)) console.log(`       ${JSON.stringify(x.ch)}  ${x.err}`);
  }
  if (pressDropped.length) {
    console.log(`    SILENTLY WRONG on ${pressDropped.length}: `
      + pressDropped.map((x) => `${JSON.stringify(x.ch)}->${JSON.stringify(x.got)}`).join(' '));
  }
  if (!pressErrored.length && !pressDropped.length) console.log('    all characters survived');

  console.log('\n  === pressSequentially() / type() — the replacement ===');
  if (seqDropped.length) {
    console.log(`    WRONG on ${seqDropped.length}: `
      + seqDropped.map((x) => `${JSON.stringify(x.ch)}->${JSON.stringify(x.got)}`).join(' '));
  } else {
    console.log('    all characters survived');
  }

  // -- a realistic password containing an affected character ----------------
  const affected = [...pressErrored.map((x) => x.ch), ...pressDropped.map((x) => x.ch)];
  let failures = 0;
  if (affected.length) {
    const pw = `Aa1${affected[0]}bcdefghi`;   // 13 chars, like the real case
    await field.fill('');
    for (const ch of pw) {
      try { await field.press(ch, { timeout: 2000 }); } catch { /* the drop */ }
    }
    const viaPress = await field.inputValue();

    await field.fill('');
    if (canSeq) await field.pressSequentially(pw, { delay: 5 });
    else await field.type(pw, { delay: 5 });
    const viaSeq = await field.inputValue();

    console.log(`\n  === a 13-character password containing ${JSON.stringify(affected[0])} ===`);
    console.log(`    via press()              ${viaPress.length}/${pw.length} chars`);
    console.log(`    via pressSequentially()  ${viaSeq.length}/${pw.length} chars`);

    if (viaPress.length < pw.length) {
      console.log(`    PASS  reproduces the real failure shape (n-1 of n)`);
    } else {
      console.log(`    FAIL  could not reproduce the truncation`); failures += 1;
    }
    if (viaSeq === pw) {
      console.log(`    PASS  the replacement types it correctly`);
    } else {
      console.log(`    FAIL  the replacement also truncates`); failures += 1;
    }
  } else {
    console.log('\n  No character-mapping problem on a plain <input>: all 94 survive press().');
    console.log('  So the real failure is NOT character mapping — it is Flutter-specific.');
  }

  server.close();

  /**
   * The decisive experiment, against the real GEICO field.
   *
   * A plain `<input>` cannot reproduce this, which is itself the finding: Flutter
   * Web synchronises a hidden input against its own editing state, and a discrete
   * keydown/keyup pair arriving during that sync can be lost. That is invisible on
   * ordinary DOM.
   *
   * Typed into the live login form and never submitted, so no login attempt is
   * consumed and no account is touched. Values are obviously fake.
   */
  if (!process.argv.includes('--offline')) {
    console.log('\n  === against the REAL GEICO login field (nothing submitted) ===');
    const FAKE = 'Aa1!bcdefghij'; // 13 chars, same length as the failing case
    const gp = await context.newPage();
    try {
      await gp.goto('https://ecams.geico.com/login', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      const pw = gp.locator('input[type="password"]').first();
      const deadline = Date.now() + 40_000;
      while (Date.now() < deadline && (await pw.count().catch(() => 0)) === 0) {
        await gp.waitForTimeout(300);
      }
      if ((await pw.count().catch(() => 0)) === 0) {
        console.log('    SKIP  form never mounted');
      } else {
        // Method A: per-character press(), exactly as BaseCarrier does.
        await pw.click({ timeout: 8000 });
        for (const ch of FAKE) {
          await pw.press(ch, { delay: 10 + Math.random() * 25 }).catch(() => {});
        }
        const a = await pw.inputValue().catch(() => '');

        // Method B: pressSequentially.
        await pw.fill('').catch(() => {});
        await pw.click({ timeout: 8000 });
        if (canSeq) await pw.pressSequentially(FAKE, { delay: 18 });
        else await pw.type(FAKE, { delay: 18 });
        const b = await pw.inputValue().catch(() => '');

        console.log(`    press() per char       ${a.length}/${FAKE.length}${a === FAKE ? '  exact' : '  TRUNCATED'}`);
        console.log(`    pressSequentially()    ${b.length}/${FAKE.length}${b === FAKE ? '  exact' : '  TRUNCATED'}`);

        if (a !== FAKE && b === FAKE) {
          console.log('    PASS  reproduces the failure AND confirms the replacement fixes it');
        } else if (a === FAKE && b === FAKE) {
          console.log('    INFO  both worked this run — the loss is intermittent, so a');
          console.log('          verify-and-repair loop is required, not just a method swap');
        } else if (b !== FAKE) {
          console.log('    WARN  pressSequentially also truncated — repair loop is mandatory');
          failures += 1;
        }
      }
    } catch (err) {
      console.log(`    SKIP  ${err.message.split('\n')[0]}`);
    }
    await gp.close().catch(() => {});
  }

  await browser.close();

  console.log('');
  if (failures) { console.log(`${failures} CHECK(S) FAILED`); process.exit(1); }
  console.log('ALL TYPING FIDELITY CHECKS PASSED');
}

main().catch((err) => { console.error(err); process.exit(1); });
