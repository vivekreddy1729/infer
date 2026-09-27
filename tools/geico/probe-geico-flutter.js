#!/usr/bin/env node
/**
 * GEICO Flutter-semantics probe.
 *
 * ISOLATION: self-contained, imports only non-carrier infrastructure. Never
 * import from progressive.js. See tools/geico/probe-geico-dom.js header.
 *
 * ------------------------------------------------------------------------
 * WHAT probe-geico-dom.js FOUND, AND THE CONTRADICTION IT LEFT
 * ------------------------------------------------------------------------
 * GEICO's login page is NOT a closed shadow root -- it reports 0 shadow roots
 * of any kind. The earlier "closed shadow DOM" verdict was wrong. What it
 * actually is:
 *
 *   - a Flutter Web application  (`flt-semantics`, `flt-semantic-node-N`,
 *     `data-semantics-role="text-field"`)
 *   - the login form mounts LATE, ~5,985ms after domcontentloaded, behind an
 *     Imperva JS challenge
 *
 * And one contradiction worth resolving before writing a single selector:
 *
 *   light-DOM scan  ->  <input type=password  id=None  name=None>
 *   keyboard Tab    ->  <input type=password  id='current-password'
 *                              name='current-password'
 *                              autocomplete='current-password'>
 *
 * Same element, two different attribute sets, depending on whether focus had
 * entered it. That is not a race -- it is how Flutter Web works. Flutter paints
 * to canvas and does not maintain a real accessible DOM until it believes an
 * assistive technology is present. Until then the input is a bare shell with no
 * id, no name, and no stable hook.
 *
 * WHY THIS MATTERS MORE THAN IT SOUNDS
 * An adapter built from what devtools shows after a human has clicked the field
 * would pass review and then fail in production, because automation arrives
 * before any focus event and sees the bare shell. This is the same shape as
 * F-08 (Progressive's generated ids) -- a selector that works once, by accident.
 *
 * THE HYPOTHESIS UNDER TEST
 * Flutter ships a hidden activation affordance, `<flt-semantics-placeholder>`
 * with `aria-label="Enable accessibility"`. Activating it switches the
 * semantics tree on permanently for the session, at which point every field
 * materialises with real, *authored* ids -- `username`, `current-password` --
 * which are far better selectors than anything Progressive offers.
 *
 * If true, the adapter is: enable semantics once, then use ordinary selectors.
 * If false, the fallback is keyboard traversal, which is already proven to
 * reach the password field but is markedly more brittle.
 *
 * Public login page only. No credentials, no submit.
 *
 *   node tools/geico/probe-geico-flutter.js
 *   node tools/geico/probe-geico-flutter.js --headed
 */

import { chromium } from 'patchright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchOptions, contextOptions } from '../../src/browser/stealth.js';

const URL = 'https://ecams.geico.com/login';
const OUT_DIR = 'artifacts/probes/geico';
const HEADED = process.argv.includes('--headed');

/** Full input inventory, including the Flutter-specific scaffolding. */
const INVENTORY = `(() => {
  const d = (el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type'),
    id: el.id || null,
    name: el.getAttribute('name') || null,
    autocomplete: el.getAttribute('autocomplete') || null,
    ariaLabel: el.getAttribute('aria-label') || null,
    role: el.getAttribute('role') || null,
    semanticsRole: el.getAttribute('data-semantics-role') || null,
    visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
    // Flutter authors these; they are not minted per load like Progressive's.
    idLooksGenerated: !!el.id && /^(input|:r)?[0-9a-f]{8,}$/i.test(el.id),
  });
  return {
    inputs: [...document.querySelectorAll('input, textarea')].map(d),
    buttons: [...document.querySelectorAll('button, [role=button], flt-semantics[role=button]')]
      .slice(0, 25)
      .map((el) => ({ ...d(el), text: (el.textContent || '').trim().slice(0, 60) })),
    flutter: {
      hasGlassPane: !!document.querySelector('flt-glass-pane, flutter-view'),
      hasCanvas: !!document.querySelector('canvas'),
      canvasCount: document.querySelectorAll('canvas').length,
      semanticsHost: !!document.querySelector('flt-semantics-host'),
      semanticsNodes: document.querySelectorAll('flt-semantics').length,
      placeholder: (() => {
        const p = document.querySelector('flt-semantics-placeholder');
        if (!p) return null;
        return {
          ariaLabel: p.getAttribute('aria-label'),
          role: p.getAttribute('role'),
          tabindex: p.getAttribute('tabindex'),
          rect: p.getBoundingClientRect().toJSON(),
        };
      })(),
      // CanvasKit vs the HTML renderer changes nothing about semantics, but it
      // tells us whether text is paintable-only (canvas) or also in the DOM.
      renderer: document.querySelector('flt-scene-host') ? 'canvaskit-or-html'
              : (document.querySelector('canvas') ? 'canvas' : 'unknown'),
    },
  };
})()`;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const base = launchOptions({ headless: !HEADED });
  let browser;
  for (const ch of ['chrome', 'chromium', undefined]) {
    try { browser = await chromium.launch({ ...base, channel: ch }); console.log(`channel: ${ch ?? 'bundled'}`); break; }
    catch (e) { console.log(`  launch failed channel=${ch ?? 'none'}: ${e.message.split('\n')[0]}`); }
  }
  if (!browser) throw new Error('no browser channel available');

  const context = await browser.newContext(contextOptions());
  const page = await context.newPage();

  const report = { probedAt: new Date().toISOString(), url: URL, stages: {} };

  console.log(`\nloading ${URL}`);
  const started = Date.now();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });

  // Wait for the Flutter app to mount. Poll for the password shell.
  const deadline = Date.now() + 40_000;
  let mountMs = null;
  while (Date.now() < deadline) {
    if (await page.locator('input[type="password"]').count() > 0) { mountMs = Date.now() - started; break; }
    await page.waitForTimeout(400);
  }
  console.log(`  flutter app mounted, password shell present at ${mountMs}ms`);
  report.mountMs = mountMs;

  // ---- STAGE 1: before semantics are enabled ----
  report.stages.beforeSemantics = await page.evaluate(INVENTORY);
  const b = report.stages.beforeSemantics;
  console.log('\n--- STAGE 1: before enabling semantics ---');
  console.log(`  flutter glass pane   : ${b.flutter.hasGlassPane}`);
  console.log(`  canvas elements      : ${b.flutter.canvasCount}`);
  console.log(`  flt-semantics nodes  : ${b.flutter.semanticsNodes}`);
  console.log(`  semantics placeholder: ${b.flutter.placeholder ? JSON.stringify(b.flutter.placeholder.ariaLabel) : 'ABSENT'}`);
  console.log(`  inputs               : ${b.inputs.length}`);
  for (const i of b.inputs.filter((x) => x.visible)) {
    console.log(`     type=${i.type} id=${i.id} name=${i.name} autocomplete=${i.autocomplete} semanticsRole=${i.semanticsRole}`);
  }
  report.stages.beforeSemantics.locators = {
    '#username': await page.locator('#username').count(),
    '#current-password': await page.locator('#current-password').count(),
    'input[autocomplete="current-password"]': await page.locator('input[autocomplete="current-password"]').count(),
  };
  console.log(`  locator #username=${report.stages.beforeSemantics.locators['#username']} `
    + `#current-password=${report.stages.beforeSemantics.locators['#current-password']}`);

  // ---- STAGE 2: enable Flutter's semantics tree ----
  console.log('\n--- STAGE 2: enabling Flutter semantics ---');
  const enable = await page.evaluate(`(() => {
    const p = document.querySelector('flt-semantics-placeholder');
    if (!p) return { method: 'none', reason: 'placeholder absent' };
    // Flutter listens for click/pointer activation on the placeholder. Dispatch
    // a real click rather than .click() on a zero-size node, which can miss.
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return { method: 'placeholder-click', ariaLabel: p.getAttribute('aria-label') };
  })()`);
  console.log(`  activation: ${JSON.stringify(enable)}`);
  report.semanticsActivation = enable;

  await page.waitForTimeout(1200);

  report.stages.afterSemantics = await page.evaluate(INVENTORY);
  const a = report.stages.afterSemantics;
  console.log(`  flt-semantics nodes  : ${b.flutter.semanticsNodes} -> ${a.flutter.semanticsNodes}`);
  console.log(`  inputs               : ${b.inputs.length} -> ${a.inputs.length}`);
  for (const i of a.inputs.filter((x) => x.visible)) {
    console.log(`     type=${i.type} id=${i.id} name=${i.name} autocomplete=${i.autocomplete} aria-label=${i.ariaLabel}`);
  }
  a.locators = {
    '#username': await page.locator('#username').count(),
    '#current-password': await page.locator('#current-password').count(),
    'input[autocomplete="current-password"]': await page.locator('input[autocomplete="current-password"]').count(),
    'input[autocomplete="email"]': await page.locator('input[autocomplete="email"]').count(),
    'flt-semantics[role="button"]': await page.locator('flt-semantics[role="button"]').count(),
  };
  console.log('  locator counts after:');
  for (const [k, v] of Object.entries(a.locators)) console.log(`     ${k.padEnd(42)} ${v}`);

  // ---- STAGE 3: does focus alone materialise ids, without the placeholder? ----
  console.log('\n--- STAGE 3: focus-driven materialisation (independent route) ---');
  const p2 = await context.newPage();
  await p2.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  const dl2 = Date.now() + 40_000;
  while (Date.now() < dl2) {
    if (await p2.locator('input[type="password"]').count() > 0) break;
    await p2.waitForTimeout(400);
  }
  const beforeTab = await p2.locator('#username').count();
  for (let i = 0; i < 8; i++) await p2.keyboard.press('Tab');
  await p2.waitForTimeout(600);
  const afterTab = await p2.locator('#username').count();
  console.log(`  #username count  before tabbing: ${beforeTab}   after tabbing: ${afterTab}`);
  report.stages.focusRoute = { beforeTab, afterTab };

  /**
   * STAGE 4: can we actually type into the field, which is the only question
   * that matters. A count of 1 proves the node exists; it does not prove
   * Playwright considers it actionable, and Flutter's canvas overlay is exactly
   * the kind of thing that intercepts pointer events (cf. O-5, where a styled
   * proxy made check() hang for 3s and silently fail).
   */
  console.log('\n--- STAGE 4: can we type into it? ---');
  const typeTest = {};
  for (const [label, sel] of [['username', '#username'], ['password', '#current-password']]) {
    try {
      const loc = page.locator(sel).first();
      await loc.fill('');
      await loc.type('probe', { delay: 20, timeout: 8000 });
      typeTest[label] = { ok: true, readBack: await loc.inputValue() };
    } catch (err) {
      typeTest[label] = { ok: false, error: err.message.split('\n')[0] };
    }
  }
  for (const [k, v] of Object.entries(typeTest)) {
    console.log(`  ${k.padEnd(9)} ${v.ok ? `OK, value read back = ${JSON.stringify(v.readBack)}` : `FAILED -- ${v.error}`}`);
  }
  report.typeTest = typeTest;

  // Submit affordance -- Flutter buttons are semantics nodes, not <button>.
  console.log('\n--- submit affordance ---');
  const submits = await page.evaluate(`(() => {
    const out = [];
    for (const el of document.querySelectorAll('flt-semantics[role=button], button, [role=button]')) {
      const t = (el.getAttribute('aria-label') || el.textContent || '').trim();
      if (t) out.push({ tag: el.tagName.toLowerCase(), id: el.id || null, label: t.slice(0, 60) });
    }
    return out.slice(0, 20);
  })()`);
  for (const s of submits) console.log(`  <${s.tag} id=${s.id}> ${JSON.stringify(s.label)}`);
  report.submitCandidates = submits;

  await page.screenshot({ path: path.join(OUT_DIR, 'flutter-semantics-on.png') });
  await writeFile(path.join(OUT_DIR, 'flutter-probe.json'), JSON.stringify(report, null, 2));

  console.log('\n================ VERDICT ================');
  const ok = typeTest.username?.ok && typeTest.password?.ok;
  if (ok) {
    console.log('  GEICO IS AUTOMATABLE with ordinary selectors.');
    console.log('  Authored, stable ids: #username and #current-password');
    console.log(`  Requires: wait ~${mountMs}ms for the Flutter app to mount.`);
    console.log(`  Semantics placeholder needed: ${a.locators['#username'] > b.stages?.locators?.['#username'] ? 'yes' : 'apparently not'}`);
  } else {
    console.log('  Selector typing FAILED. Fall back to keyboard traversal.');
  }
  console.log('=========================================');

  await browser.close();
  console.log(`\nwrote ${path.join(OUT_DIR, 'flutter-probe.json')}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
