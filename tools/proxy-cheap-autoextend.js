#!/usr/bin/env node
/**
 * Turn auto-extend on or off for a Proxy-Cheap proxy.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE TOOL WITH A CONFIRMATION FLAG
 * ------------------------------------------------------------------------
 * Auto-extend is the one management-API write this repo wraps, and it is the only one
 * worth wrapping. The argument for it is the same argument that justifies sticky
 * sessions in the first place: a proxy that lapses does not degrade gracefully, it
 * drops the exit IP. The next pull leaves from somewhere else, the carrier sees a
 * recognised account arriving from a new address, and the cost is a fresh device
 * challenge at best.
 *
 * The argument against automating it is that it spends money without asking — the
 * provider charges account balance on renewal. So it lives here rather than in the
 * app, requires an explicit proxy id, and requires `--yes`. Everything else in the
 * ordering API (`/v2/order/{id}/execute`, `extend-period`, `buy-bandwidth`) is not
 * wrapped at all.
 *
 * `rotate-ip` is deliberately absent for a different reason: it would destroy the
 * stickiness the whole design depends on, so there is no correct moment to call it.
 *
 *   node tools/proxy-cheap-autoextend.js                # show current state, change nothing
 *   node tools/proxy-cheap-autoextend.js <id> --enable --yes
 *   node tools/proxy-cheap-autoextend.js <id> --disable --yes
 *
 * Run it with no arguments first — it lists the proxy ids on the account.
 */

import {
  hasApiCredentials,
  listProxies,
  getProxy,
  getBalance,
  setAutoExtend,
} from '../src/browser/proxyCheapApi.js';

const args = process.argv.slice(2);
const id = args.find((a) => /^\d+$/.test(a));
const wantEnable = args.includes('--enable');
const wantDisable = args.includes('--disable');
const confirmed = args.includes('--yes');

async function main() {
  if (!hasApiCredentials()) {
    console.error('PROXYCHEAP_API_KEY / PROXYCHEAP_API_SECRET are not set in .env.');
    process.exitCode = 1;
    return;
  }

  // No id, or no action: report and exit. A tool that can spend money defaults to
  // telling you things.
  if (!id || (!wantEnable && !wantDisable)) {
    const proxies = await listProxies();
    let balance = null;
    try {
      balance = (await getBalance())?.balance ?? null;
    } catch {
      /* not fatal */
    }

    console.log(`account balance: ${balance ?? '(unavailable)'}\n`);
    for (const p of proxies) {
      let detail = p;
      try {
        detail = { ...p, ...(await getProxy(p.id)) };
      } catch {
        /* list data is enough for this view */
      }
      const left = detail.expiresAt
        ? Math.round((new Date(detail.expiresAt).getTime() - Date.now()) / 86_400_000)
        : null;
      console.log(
        `  ${detail.id}  ${String(detail.status).padEnd(8)} autoExtend=${
          detail.autoExtendEnabled ?? '?'
        }  expires ${detail.expiresAt ?? '?'}${left === null ? '' : ` (${left}d)`}`
      );
    }

    /**
     * The interaction that makes `autoExtendEnabled: true` misleading. Stated here
     * because this is the screen someone looks at to reassure themselves.
     */
    if (balance === 0 && proxies.some((p) => p.autoExtendEnabled)) {
      console.log('\n  ! Auto-extend renews from account balance, and the balance is 0.');
      console.log('    The flag is on and will not save you. Top up before the expiry above.');
    }

    console.log('\nTo change one:');
    console.log('  node tools/proxy-cheap-autoextend.js <id> --enable --yes');
    console.log('\nEnabling authorises the provider to charge account balance on renewal.');
    return;
  }

  if (wantEnable && wantDisable) {
    console.error('Pass either --enable or --disable, not both.');
    process.exitCode = 1;
    return;
  }

  const enable = wantEnable;

  if (!confirmed) {
    console.log(`Would ${enable ? 'ENABLE' : 'DISABLE'} auto-extend on proxy ${id}.`);
    if (enable) {
      console.log('This authorises Proxy-Cheap to charge your account balance on renewal.');
    } else {
      console.log('The proxy will then lapse at its expiry date and the exit IP will change.');
    }
    console.log('Re-run with --yes to apply.');
    return;
  }

  const before = await getProxy(id);
  if (before.autoExtendEnabled === enable) {
    console.log(`Proxy ${id} already has autoExtendEnabled=${enable}. Nothing to do.`);
    return;
  }

  await setAutoExtend(id, enable);

  // Read back rather than trusting the 200. A write that reports success without
  // taking effect is the failure mode worth catching, and it costs one GET.
  const after = await getProxy(id);
  if (after.autoExtendEnabled === enable) {
    console.log(`Proxy ${id}: autoExtendEnabled is now ${after.autoExtendEnabled}.`);
  } else {
    console.error(
      `Proxy ${id}: the call succeeded but autoExtendEnabled reads ${after.autoExtendEnabled}. Check the dashboard.`
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
