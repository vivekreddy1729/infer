#!/usr/bin/env node
/**
 * Prove the proxy is sticky before trusting it with a real carrier login.
 *
 * ------------------------------------------------------------------------
 * THE PROBLEM THIS SOLVES
 * ------------------------------------------------------------------------
 * A wrong sticky-session template does not fail. Residential gateways parse the
 * username, apply the flags they recognise, and silently ignore the rest — so a typo
 * gives you a perfectly working proxy that rotates on every connection.
 *
 * The consequence lands three layers away: login egresses from one IP, the MFA submit
 * from another, the document fetch from a third. The carrier sees a session hopping
 * between cities and invalidates it, and the error you get back says
 * "your session expired" or asks for another code. Nothing points at a username.
 *
 * Every provider spells stickiness differently and there is no standard:
 *
 *     sid-<id> plus ttl-<seconds>     session lifetime as a separate flag
 *     -session-<id>                   suffix, dash-delimited
 *     session-<id>                    suffix, no leading dash
 *     sessionid-<id>
 *     <user>_session-<id>_lifetime-10m
 *
 * So rather than assume any of them, this measures. It is the difference between
 * "the config looks right" and "the config demonstrably works".
 *
 *   npm run proxy:verify
 *   npm run proxy:verify -- --requests 6 --hold 90
 *
 *   --requests N   probes per session (default 4)
 *   --hold S       seconds to wait between the first and last probe (default 45),
 *                  so the test spans a realistic pull including a human MFA wait
 */

import { chromium } from 'patchright';
import config from '../src/config.js';
import { buildProxyConfig, newStickySessionId } from '../src/browser/proxy.js';
import { probeExitIp } from '../src/browser/proxyHealth.js';
import { launchOptions, contextOptions } from '../src/browser/stealth.js';
import {
  hasApiCredentials,
  listProxies,
  stickinessFor,
} from '../src/browser/proxyCheapApi.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
};
const REQUESTS = Math.max(2, arg('requests', 4));
const HOLD_S = Math.max(0, arg('hold', 45));

let failures = 0;
const pass = (m, d = '') => console.log(`  \u001b[32mPASS\u001b[0m  ${m}${d ? `  ${d}` : ''}`);
const fail = (m, d = '') => { failures += 1; console.log(`  \u001b[31mFAIL\u001b[0m  ${m}${d ? `  ${d}` : ''}`); };
const info = (m) => console.log(`  ·     ${m}`);

/** Mask an IP for output. Enough to compare, not enough to publish. */
const mask = (ip) => (ip ? ip.replace(/^(\d+)\.(\d+)\..*/, '$1.$2.x.x') : '(none)');

async function launch() {
  for (const channel of ['chrome', 'chromium', undefined]) {
    try { return await chromium.launch({ ...launchOptions({ headless: true }), channel }); }
    catch { /* next */ }
  }
  throw new Error('no browser channel available');
}

/** Probe the exit IP `n` times on one sticky session, spread over `holdMs`. */
async function probeSession(browser, sessionId, n, holdMs) {
  const proxy = buildProxyConfig(sessionId);
  const context = await browser.newContext({ ...contextOptions(), ...(proxy ? { proxy } : {}) });
  const results = [];
  const gap = n > 1 ? Math.round(holdMs / (n - 1)) : 0;

  for (let i = 0; i < n; i++) {
    const r = await probeExitIp(context, { timeoutMs: 15_000 });
    results.push(r);
    const label = r.ok ? `${mask(r.ip)} via ${r.service} (${r.latencyMs}ms)` : `unreachable: ${r.error}`;
    info(`probe ${i + 1}/${n}  ${label}`);
    if (i < n - 1 && gap > 0) {
      info(`         waiting ${(gap / 1000).toFixed(0)}s…`);
      await new Promise((res) => setTimeout(res, gap));
    }
  }

  await context.close();
  return results;
}

async function main() {
  console.log('\n\u001b[1mProxy verification\u001b[0m\n');

  if (!config.RESIDENTIAL_PROXY_URL) {
    console.log('  No RESIDENTIAL_PROXY_URL set — nothing to verify.\n');
    console.log('  Set it in .env, e.g. for Proxy-Cheap residential:');
    console.log('      RESIDENTIAL_PROXY_URL=http://USER:PASS@gate.proxy-cheap.com:PORT');
    console.log('      PROXY_USERNAME_TEMPLATE={user}-session-{session}\n');
    console.log('  Host, port, and the exact sticky syntax come from your Proxy-Cheap');
    console.log('  dashboard. Their published API docs cover ordering, not connecting.\n');
    process.exit(0);
  }

  let host = 'unparseable';
  let hostname = '';
  try {
    const u = new URL(config.RESIDENTIAL_PROXY_URL);
    host = u.host;
    hostname = u.hostname;
  } catch { /* reported below */ }

  /**
   * Establish which product this is BEFORE judging anything.
   *
   * ------------------------------------------------------------------------
   * WHY — this test previously failed a correctly configured proxy
   * ------------------------------------------------------------------------
   * The original version assumed one product: a rotating residential gateway, where
   * a missing `PROXY_USERNAME_TEMPLATE` means every connection may rotate, and a second
   * session landing on the same IP means the template is being ignored. Both are sound
   * for that product.
   *
   * On a dedicated-IP product they are exactly inverted. A `RESIDENTIAL_STATIC` proxy
   * *is* one exit IP: there is no session concept to encode, a template would rewrite a
   * username the provider expects verbatim and break authentication, and a second
   * session landing on the same IP is the entire point of the purchase.
   *
   * Run against three real `RESIDENTIAL_STATIC` proxies this reported two failures and
   * the advice "do not spend a real login on a rotating proxy" — about a proxy that had
   * just held one IP for 45 seconds. It even printed the correct caveat in prose and
   * then failed anyway. That is a tool producing a confident wrong verdict, which this
   * project has now seen four times (F-06, the closed-shadow-root call, the probe
   * stage-4 bug, and this).
   *
   * So: ask the management API what was actually bought, and match the expectations to
   * the product. When the API is unavailable, say the verdict is provisional rather
   * than guessing at one.
   */
  let product = null;
  let productSource = '';
  if (hasApiCredentials() && hostname) {
    try {
      const all = await listProxies();
      const match = all.find(
        (p) => p.connection?.connectIp === hostname || p.connection?.publicIp === hostname
      );
      if (match) {
        product = { networkType: match.networkType, ...stickinessFor(match), proxy: match };
        productSource = `management API (proxy ${match.id})`;
      } else {
        productSource = 'management API reachable, but no account proxy matches this host';
      }
    } catch (err) {
      productSource = `management API unavailable: ${err.message}`;
    }
  } else {
    productSource = hasApiCredentials() ? 'host unparseable' : 'PROXYCHEAP_API_* not set';
  }

  const dedicated = product ? !product.needsTemplate : null;

  console.log(`  gateway            ${host}`);
  console.log(`  product            ${product ? product.networkType : 'unknown'}   (${productSource})`);
  console.log(`  expected model     ${dedicated === null ? 'unknown' : dedicated ? 'dedicated exit IP — one IP for every session' : 'rotating gateway — sticky username required'}`);
  console.log(`  sticky template    ${config.PROXY_USERNAME_TEMPLATE ?? '(none)'}`);
  console.log(`  probes per session ${REQUESTS} over ${HOLD_S}s`);
  console.log('');

  if (dedicated === true) {
    // Dedicated IP: the template must be ABSENT. Presence is the defect here.
    if (config.PROXY_USERNAME_TEMPLATE) {
      fail('PROXY_USERNAME_TEMPLATE is set on a dedicated-IP proxy',
        'it rewrites a username the provider expects verbatim; auth will fail and look like an IP block');
    } else {
      pass('no template, correct for a dedicated exit IP', product.reason);
    }
  } else if (dedicated === false) {
    if (!config.PROXY_USERNAME_TEMPLATE) {
      fail('no PROXY_USERNAME_TEMPLATE on a rotating gateway',
        'without it every connection may rotate; a pull cannot hold one IP');
    } else if (!config.PROXY_USERNAME_TEMPLATE.includes('{session}')) {
      fail('PROXY_USERNAME_TEMPLATE has no {session} placeholder',
        'the same username is sent every time, so the provider cannot distinguish sessions');
    } else {
      pass('template contains a {session} placeholder');
    }
  } else {
    /**
     * Product unknown. Do not fail on the template either way — the measurements
     * below are the real evidence, and an unverifiable assumption should not
     * produce a failing verdict. Say so explicitly instead.
     */
    info('Product type unknown, so the template is not judged here.');
    info('Set PROXYCHEAP_API_KEY / PROXYCHEAP_API_SECRET for a definitive answer,');
    info('or read the measurements below, which stand on their own.');
  }

  const browser = await launch();

  // -- 1. one session must hold one IP, across a realistic span ---------------
  console.log('\n  \u001b[1mSession A — the same session must keep one IP\u001b[0m');
  const sessionA = newStickySessionId();
  const a = await probeSession(browser, sessionA, REQUESTS, HOLD_S * 1000);
  const aIps = a.filter((r) => r.ok).map((r) => r.ip);
  const aUnique = [...new Set(aIps)];

  if (aIps.length === 0) {
    fail('every probe failed', 'the proxy may be down, or the credentials are wrong');
  } else if (aIps.length < REQUESTS) {
    info(`${REQUESTS - aIps.length} probe(s) could not reach an echo service — not counted as rotation`);
  }

  if (aUnique.length === 1 && aIps.length >= 2) {
    pass(`STICKY — one IP held across ${aIps.length} probes over ${HOLD_S}s`, mask(aUnique[0]));
  } else if (aUnique.length > 1) {
    fail(`ROTATED — ${aUnique.length} different IPs on one session`,
      aUnique.map(mask).join(', '));
    info('The sticky template is not being honoured. A carrier pull will break mid-flow:');
    info('login, MFA and document fetch would each leave from a different IP.');
    info('Check the exact syntax in your Proxy-Cheap dashboard and adjust');
    info('PROXY_USERNAME_TEMPLATE, then re-run this.');
  }

  // -- 2. a different session should get a different IP ----------------------
  /**
   * The negative control, and the reason this test is not self-congratulatory.
   *
   * If session A held one IP, that could mean stickiness works — or that the provider
   * gave this account a single static exit and the template is doing nothing at all.
   * Those look identical from test 1 and behave very differently under load.
   *
   * A second session should land elsewhere. If it does not, the "stickiness" observed
   * above is not attributable to the configuration.
   */
  const bHeading = dedicated === true
    ? 'Session B — a second session must get the SAME IP'
    : 'Session B — a different session should get a different IP';
  console.log(`\n  \u001b[1m${bHeading}\u001b[0m`);
  const sessionB = newStickySessionId();
  const b = await probeSession(browser, sessionB, 2, 2000);
  const bIps = [...new Set(b.filter((r) => r.ok).map((r) => r.ip))];

  const sameAsA = aUnique.length === 1 && bIps.length === 1 && bIps[0] === aUnique[0];

  if (!bIps.length) {
    info('session B probes failed; the control is inconclusive');
  } else if (dedicated === true) {
    /**
     * Inverted control for a dedicated IP.
     *
     * Here "session B differs" is the failure, not the success. A dedicated proxy
     * that hands out a second address means the exit is not actually fixed, and a
     * pull spanning a human MFA wait could hop — the precise failure this whole
     * design exists to prevent. Same IP is the required outcome.
     */
    if (sameAsA) {
      pass('one exit IP across independent sessions', mask(aUnique[0]));
      info('Correct for this product: the IP is a property of the proxy, not of a');
      info('username, so nothing in the pull can cause it to change.');
    } else {
      fail('a dedicated-IP proxy returned more than one exit IP',
        [...new Set([...aUnique, ...bIps])].map(mask).join(', '));
      info('This contradicts the product type reported by the management API.');
      info('A pull spanning an MFA wait could egress from two addresses.');
    }
  } else if (sameAsA) {
    fail('session B got the SAME IP as session A',
      'on a rotating gateway this means the sticky template is being ignored entirely');
  } else if (aUnique.length === 1) {
    pass('sessions are independent', `A=${mask(aUnique[0])}  B=${mask(bIps[0])}`);
    info('This is the important pair: A stayed put AND B differed, so the session');
    info('token is genuinely controlling the exit rather than coinciding with it.');
  }

  // -- 3. is the exit residential? ------------------------------------------
  /**
   * Reported, not asserted. Datacenter detection needs an ASN lookup against a service
   * this tool should not depend on, and a false "not residential" would be worse than
   * silence. The latency shape is a weak hint worth printing: residential exits are
   * typically slower and more variable than datacenter ones, so unusually fast and
   * uniform timings are worth a second look at what you actually bought.
   */
  const lats = a.filter((r) => r.ok).map((r) => r.latencyMs);
  if (lats.length >= 2) {
    const avg = Math.round(lats.reduce((x, y) => x + y, 0) / lats.length);
    const spread = Math.max(...lats) - Math.min(...lats);
    console.log('');
    info(`exit latency avg ${avg}ms, spread ${spread}ms`);
    if (avg < 120 && spread < 40) {
      info('Unusually fast and uniform for a residential exit — worth confirming the');
      info('plan is residential rather than datacenter.');
    }
  }

  await browser.close();

  /**
   * Will it still be there tomorrow?
   *
   * Stickiness within a pull is necessary but not sufficient for "nothing gets dropped
   * in between". A proxy that lapses between pulls is the same outage with a longer
   * fuse, and the interaction that actually causes it is easy to miss: auto-extend
   * renews from account balance, so `autoExtendEnabled: true` with a zero balance is
   * not protection, it is a renewal that will fail on the day it matters.
   *
   * Checked here rather than left to the dashboard because this is the script someone
   * runs before trusting the proxy, and a 30-day fuse is invisible at that moment.
   */
  if (product?.proxy) {
    const p = product.proxy;
    const leftDays = p.expiresAt
      ? Math.round((new Date(p.expiresAt).getTime() - Date.now()) / 86_400_000)
      : null;
    console.log('');
    info(`expires ${p.expiresAt ?? '(unknown)'}${leftDays === null ? '' : ` — ${leftDays} day(s)`}`);
    info(`auto-extend ${p.autoExtendEnabled === undefined ? '(unknown)' : p.autoExtendEnabled}`);

    let balance = null;
    try {
      const { getBalance } = await import('../src/browser/proxyCheapApi.js');
      balance = (await getBalance())?.balance ?? null;
      info(`account balance ${balance}`);
    } catch {
      info('account balance unavailable (key may lack billing permission)');
    }

    if (p.autoExtendEnabled === true && balance === 0) {
      fail('auto-extend is ON but the account balance is 0',
        'renewal will fail and the proxy will lapse on its expiry date');
      info('Auto-extend charges account balance. With none, the flag guarantees nothing.');
      info(`Top up before ${p.expiresAt ?? 'expiry'}, or the exit IP disappears between pulls.`);
    } else if (p.autoExtendEnabled === false) {
      fail('auto-extend is OFF', 'the proxy will lapse at expiry and the exit IP will change');
    } else if (leftDays !== null && leftDays <= 7) {
      fail(`proxy expires in ${leftDays} day(s)`, 'renew before relying on it');
    }
  }

  console.log('');
  if (failures) {
    console.log(`\u001b[31m${failures} problem(s).\u001b[0m`);
    /**
     * Distinguish "the routing is broken" from "the routing works but the account
     * will lapse". The original message assumed the former for every failure and told
     * the operator to fix a template, which is wrong advice for a billing problem and
     * was wrong advice for a correctly configured dedicated IP.
     */
    const routingOk = aUnique.length === 1 && aIps.length >= 2;
    if (routingOk) {
      console.log('Routing itself is sound: one IP was held for the whole window.');
      console.log('The problems above are about the proxy continuing to exist, not about');
      console.log('how traffic is routed. A pull right now would egress correctly.\n');
    } else {
      console.log('A carrier pull is likely to break mid-flow. Do not spend a real login yet:');
      console.log('a failed attempt counts against carrier lockout limits.\n');
    }
    process.exit(1);
  }
  console.log('\u001b[32mProxy verified sticky.\u001b[0m Safe to use for a real carrier pull.');
  console.log(`Held one IP for ${HOLD_S}s; raise --hold above your worst-case pull if you want more confidence.\n`);
}

main().catch((err) => { console.error(err); process.exit(1); });
