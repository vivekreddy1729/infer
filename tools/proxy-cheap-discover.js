/**
 * Read the Proxy-Cheap account and print the `.env` it implies.
 *
 * Strictly read-only. Calls `GET /proxies`, `GET /proxies/{id}` and
 * `GET /account/balance`. Nothing here orders, extends, buys bandwidth or
 * rotates an IP — those cost money or break stickiness, and a discovery tool is
 * not where that should be possible.
 *
 * Why this exists rather than copying values out of the dashboard: two of the
 * settings are easy to get wrong in ways that fail late and look like something
 * else.
 *
 *   - `PROXY_USERNAME_TEMPLATE` only applies to a rotating gateway. On a
 *     dedicated-IP product it corrupts a username the provider expects verbatim,
 *     and the result is an auth failure that reads like a blocked IP.
 *   - the port has to match the scheme implied by `proxyType`; picking the wrong
 *     one of three ports present on the same object fails at connect time.
 *
 * Both are derivable from the API response, so they are derived.
 *
 * ---------------------------------------------------------------------------
 * ON IP WHITELISTING, WHICH THIS TOOL REPORTS BUT DOES NOT ENABLE
 * ---------------------------------------------------------------------------
 * Proxy-Cheap offers two auth modes, and `GET /proxies/{id}/change-authentication-type`
 * shows them as `["IP_WHITELIST", "USERNAME_PASSWORD"]`. It is tempting to read that as
 * "and also whitelist your IP for easier access". It is not additive — they are
 * mutually exclusive, so switching to `IP_WHITELIST` REVOKES the username and password.
 *
 * That makes it a one-way door: if the whitelisted address is wrong or changes, the
 * proxy stops answering and the only route back is this management API. Two specific
 * reasons it is the wrong default here:
 *
 *   - **The deployment target moves.** On ECS Fargate a task gets a new public address
 *     every time it is replaced, and `desiredCount = 1` with rolling restarts means that
 *     happens on every deploy. Whitelist auth would break on each one.
 *   - **Local development moves.** A home connection's address is not stable, so the
 *     whitelist would need editing whenever the ISP reassigns it.
 *
 * When it IS the better choice: once egress is pinned behind a NAT Gateway with an
 * Elastic IP. Then the address is genuinely fixed, and whitelisting is strictly better
 * than credentials — it removes the proxy password from the container environment
 * entirely, so a compromised task leaks nothing reusable. That is a post-deploy
 * hardening step, not a setup step. See the deployment guide.
 *
 *   node tools/proxy-cheap-discover.js            # secrets masked
 *   node tools/proxy-cheap-discover.js --reveal   # full .env block
 *   node tools/proxy-cheap-discover.js --json     # machine-readable
 */

import {
  hasApiCredentials,
  listProxies,
  getProxy,
  getBalance,
  getAuthType,
  toProxyUrl,
  stickinessFor,
} from '../src/browser/proxyCheapApi.js';

const REVEAL = process.argv.includes('--reveal');
const AS_JSON = process.argv.includes('--json');

const mask = (s) => {
  if (!s) return '(none)';
  if (REVEAL) return s;
  const str = String(s);
  return str.length <= 8 ? '•'.repeat(str.length) : `${str.slice(0, 3)}…${str.slice(-2)}`;
};

const days = (iso) => {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : null;
};

async function main() {
  if (!hasApiCredentials()) {
    console.error('PROXYCHEAP_API_KEY / PROXYCHEAP_API_SECRET are not set in .env.');
    process.exitCode = 1;
    return;
  }

  let proxies;
  try {
    proxies = await listProxies();
  } catch (err) {
    console.error(`Could not list proxies: ${err.message}`);
    if (err.body) console.error(`  body: ${JSON.stringify(err.body).slice(0, 300)}`);
    process.exitCode = 1;
    return;
  }

  // Balance is best-effort: the API documents a 403 for keys without billing
  // permission, and that must not fail discovery.
  let balance = null;
  let balanceNote = '';
  try {
    balance = (await getBalance())?.balance ?? null;
  } catch (err) {
    balanceNote = err.status === 403 ? 'no billing permission on this key pair' : err.message;
  }

  // `autoExtendEnabled` and `bandwidth` only appear on the per-proxy endpoint,
  // and auto-extend is the thing being verified, so each proxy is re-fetched.
  const detailed = [];
  for (const p of proxies) {
    let full = p;
    try {
      full = { ...p, ...(await getProxy(p.id)) };
    } catch (err) {
      full = { ...p, __detailError: err.message };
    }
    // Auth mode is on its own endpoint and is worth showing: it determines whether
    // the credentials in RESIDENTIAL_PROXY_URL are even consulted.
    try {
      full.__auth = await getAuthType(p.id);
    } catch {
      full.__auth = null;
    }
    detailed.push(full);
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ balance, balanceNote, proxies: detailed }, null, 2));
    return;
  }

  console.log('=== Proxy-Cheap account ===');
  console.log(`balance: ${balance ?? `unavailable (${balanceNote})`}`);
  console.log(`proxies: ${detailed.length}`);

  if (!detailed.length) {
    console.log('\nNo proxies on this account. Nothing to configure yet.');
    console.log('A proxy has to be purchased in the dashboard first — this tool will not buy one.');
    return;
  }

  const usable = [];

  for (const p of detailed) {
    const built = toProxyUrl(p);
    const sticky = stickinessFor(p);
    const left = days(p.expiresAt);

    console.log(`\n--- proxy ${p.id}`);
    console.log(`  status        ${p.status}`);
    console.log(`  networkType   ${p.networkType}${p.countryCode ? `  country=${p.countryCode}` : ''}`);
    console.log(`  proxyType     ${p.proxyType}  ->  ${built.scheme}://…:${built.port}`);
    console.log(`  host          ${p.connection?.connectIp || p.connection?.publicIp || '(none)'}`);
    console.log(`  ports         http=${p.connection?.httpPort ?? '-'} https=${p.connection?.httpsPort ?? '-'} socks5=${p.connection?.socks5Port ?? '-'}`);
    console.log(`  username      ${mask(p.authentication?.username)}`);
    console.log(`  password      ${mask(p.authentication?.password)}`);
    if (p.authentication?.whitelistedIps?.length) {
      console.log(`  whitelistIps  ${p.authentication.whitelistedIps.join(', ')}`);
    }
    console.log(`  expiresAt     ${p.expiresAt ?? '(unknown)'}${left === null ? '' : `  (${left} day(s) left)`}`);
    console.log(`  autoExtend    ${p.autoExtendEnabled === undefined ? '(unknown)' : p.autoExtendEnabled}`);
    if (p.bandwidth) {
      const { used, total } = p.bandwidth;
      console.log(`  bandwidth     ${used ?? '?'} / ${total ?? '?'}`);
    }
    if (p.metadata?.ispName) console.log(`  isp           ${p.metadata.ispName}`);
    if (p.__auth) {
      console.log(`  authType      ${p.__auth.currentAuthenticationType}   (available: ${(p.__auth.availableAuthenticationTypes || []).join(', ')})`);
    }
    console.log(`  stickiness    ${sticky.reason}`);
    if (p.__detailError) console.log(`  ! detail fetch failed: ${p.__detailError}`);
    for (const w of built.warnings) console.log(`  ! ${w}`);

    if (String(p.status).toUpperCase() === 'ACTIVE' && built.url) usable.push({ p, built, sticky, left });
  }

  console.log('\n=== What to put in .env ===');

  if (!usable.length) {
    console.log('No ACTIVE proxy with a resolvable host:port. Nothing safe to recommend.');
    console.log('A PENDING proxy is still being provisioned; re-run this once it goes ACTIVE.');
    process.exitCode = 1;
    return;
  }

  /**
   * Prefer the ACTIVE proxy with the most time left.
   *
   * Expiry is the right tiebreak because a lapse is not a slow pull, it is a
   * dropped exit IP mid-session — the failure the sticky design exists to avoid.
   */
  usable.sort((a, b) => (b.left ?? 0) - (a.left ?? 0));
  const pick = usable[0];

  if (usable.length > 1) {
    console.log(`# ${usable.length} active proxies; chose ${pick.p.id} (most time remaining).`);
    console.log('# Pinning one matters: two pulls on different exit IPs look like two users.');
  }

  console.log(`RESIDENTIAL_PROXY_URL=${REVEAL ? pick.built.url : pick.built.url.replace(/\/\/[^@]*@/, '//••••:••••@')}`);

  if (pick.sticky.needsTemplate) {
    console.log('PROXY_MODEL=rotating');
    console.log('# Rotating gateway: a sticky-session username suffix IS required.');
    console.log('# The exact syntax is provider-specific and not in the API response —');
    console.log('# confirm it in the dashboard, then verify with: npm run proxy:verify');
    console.log('PROXY_USERNAME_TEMPLATE={user}-session-{session}   # UNVERIFIED, confirm first');
  } else {
    console.log(`PROXY_MODEL=dedicated   # ${pick.p.networkType}`);
    console.log('# Dedicated exit IP: leave PROXY_USERNAME_TEMPLATE UNSET.');
    console.log('# Setting it would rewrite a username the provider expects verbatim and');
    console.log('# authentication would fail in a way that looks like an IP block.');
    console.log('# PROXY_USERNAME_TEMPLATE=');
  }

  if (!REVEAL) console.log('\n(credentials masked; re-run with --reveal to print them)');

  const warn = [];
  if (pick.left !== null && pick.left <= 7) warn.push(`expires in ${pick.left} day(s)`);
  if (pick.p.autoExtendEnabled === false) warn.push('auto-extend is OFF');
  if (!pick.p.authentication?.username) warn.push('IP-whitelist auth: the deployment egress IP must be whitelisted');
  if (warn.length) {
    console.log('\n=== Attention ===');
    for (const w of warn) console.log(`  ! ${w}`);
    if (pick.p.autoExtendEnabled === false) {
      console.log('  Auto-extend prevents a mid-pull expiry dropping the exit IP.');
      console.log(`  It renews using account balance, so it is opt-in:`);
      console.log(`    node tools/proxy-cheap-autoextend.js ${pick.p.id} --enable --yes`);
    }
  }

  console.log('\nNext: set RESIDENTIAL_PROXY_URL in .env, then `npm run proxy:verify`');
  console.log('before spending a real carrier login on it.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
