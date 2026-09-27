import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import config from '../config.js';
import logger from '../logger.js';
import { contextOptions, launchOptions } from './stealth.js';
import { installResourceBlocking } from './resourceBlocker.js';

/**
 * Browser lifecycle and context management.
 *
 * Two things this solves.
 *
 * COLD START. Launching Chrome costs 400-900ms depending on the host, and in an
 * 8s budget that is 10% spent before we have touched the network. So one
 * browser is launched at boot and kept warm; sessions get a fresh *context*
 * off it, which costs single-digit milliseconds and still gives full cookie and
 * cache isolation between users.
 *
 * PER-SESSION EGRESS. Sticky proxy credentials differ per session, and Chrome
 * normally binds its proxy at launch. Playwright exposes per-context proxy
 * overrides, but only if the browser was launched with a proxy set, so we launch
 * with the documented `per-context` sentinel and override downstream. That is
 * what lets one warm browser serve sessions on different residential exit IPs.
 *
 * There is also a persistent-profile path, used for real carriers, where
 * stealth and cookie longevity matter more than start-up cost.
 */

const log = logger.child({ module: 'browserPool' });

/**
 * Playwright only honours per-context proxy overrides if the browser was
 * launched with *some* proxy set, so this sentinel is passed at launch purely to
 * unlock that capability.
 *
 * The sharp edge: it is a real setting, not a no-op. Any context that does not
 * override it inherits an unroutable proxy and every navigation dies with
 * ERR_PROXY_CONNECTION_FAILED. So the sentinel is only installed when a
 * residential proxy is actually configured, and contexts that must not be
 * proxied are given an explicit `direct://` override rather than being left to
 * inherit.
 */
/**
 * No proxy constants here on purpose.
 *
 * There used to be two: an unroutable `http://per-context` sentinel installed at
 * launch to unlock per-context proxy overrides, and a `direct://` override for
 * contexts that must not be proxied. Both are gone — per-context proxies work
 * without a launch-time proxy on Playwright 1.63, and the `direct://` override was
 * never functional. Kept as a note so nobody reintroduces the sentinel from an old
 * Playwright doc. See ENGINEERING-LOG F-51.
 */

class BrowserPool {
  #driver = null;
  #driverName = null;
  #browser = null;
  #channel = null;
  #launching = null;
  #contexts = new Set();
  #closed = false;

  /** Dynamically resolve the automation driver so the fallback is real. */
  async #loadDriver() {
    if (this.#driver) return this.#driver;

    const preferred = config.BROWSER_DRIVER;
    const order = preferred === 'patchright' ? ['patchright', 'playwright'] : ['playwright', 'patchright'];

    for (const name of order) {
      try {
        const mod = await import(name);
        this.#driver = mod.chromium ?? mod.default?.chromium;
        if (!this.#driver) throw new Error(`${name} exported no chromium namespace`);
        this.#driverName = name;
        if (name !== preferred) {
          log.warn({ preferred, using: name }, 'preferred browser driver unavailable, fell back');
        } else {
          log.info({ driver: name }, 'browser driver loaded');
        }
        return this.#driver;
      } catch (err) {
        log.warn({ driver: name, err: err.message }, 'browser driver failed to load');
      }
    }
    throw new Error('No usable browser driver. Install patchright or playwright.');
  }

  get driverName() {
    return this.#driverName;
  }

  get channel() {
    return this.#channel;
  }

  get isReady() {
    return Boolean(this.#browser?.isConnected());
  }

  get openContextCount() {
    return this.#contexts.size;
  }

  /**
   * Launch the shared browser. Safe to call repeatedly and concurrently; the
   * in-flight promise is shared so a burst of requests at boot does not launch
   * several Chromes.
   */
  async warm() {
    if (this.#closed) throw new Error('Pool is shut down.');
    if (this.#browser?.isConnected()) return this.#browser;
    if (this.#launching) return this.#launching;

    this.#launching = (async () => {
      const chromium = await this.#loadDriver();
      /**
       * No proxy at launch. Per-context proxies work without one.
       *
       * This used to install an unroutable `http://per-context` sentinel, on the old
       * Playwright rule that per-context proxy overrides require a browser-level proxy.
       * That rule no longer holds, and the sentinel was actively breaking things.
       * Measured on Playwright/patchright 1.63, all four combinations:
       *
       *   WITH sentinel     context WITH proxy    page PASS   request PASS
       *                     context NO proxy      page FAIL   request FAIL
       *   WITHOUT sentinel  context WITH proxy    page PASS   request PASS
       *                     context NO proxy      page PASS   request PASS
       *
       * So the sentinel bought nothing and cost every unproxied context. See F-51.
       */
      const base = launchOptions({ proxy: null });

      // Real Chrome is materially better for stealth than bundled Chromium, but
      // it is not guaranteed to be installed. Try it, then degrade rather than
      // refusing to boot.
      const attempts = [
        { ...base, channel: 'chrome' },
        { ...base, channel: 'chromium' },
        { ...base, channel: undefined },
      ];

      let lastErr;
      for (const opts of attempts) {
        try {
          const started = performance.now();
          const browser = await chromium.launch(opts);
          this.#browser = browser;
          this.#channel = opts.channel ?? 'bundled-chromium';
          log.info(
            {
              driver: this.#driverName,
              channel: this.#channel,
              headless: opts.headless,
              launchMs: Math.round(performance.now() - started),
            },
            'browser warm'
          );
          browser.on('disconnected', () => {
            log.warn('browser disconnected');
            this.#browser = null;
          });
          return browser;
        } catch (err) {
          lastErr = err;
          log.warn({ channel: opts.channel, err: err.message }, 'browser launch attempt failed');
        }
      }
      throw new Error(`Could not launch a browser: ${lastErr?.message}`);
    })().finally(() => {
      this.#launching = null;
    });

    return this.#launching;
  }

  /**
   * Isolated context for one pull.
   *
   * @param {object}  opts
   * @param {object=} opts.proxy         Sticky proxy config, or null for direct.
   * @param {object=} opts.storageState  Rehydrated cookies/localStorage.
   * @param {boolean} opts.blockStylesheets
   * @param {string[]} opts.extraAllow
   */
  async acquireContext({
    proxy = null,
    storageState = null,
    blockStylesheets = false,
    extraAllow = [],
  } = {}) {
    const browser = await this.warm();
    const started = performance.now();

    /**
     * Omit `proxy` entirely when there is none.
     *
     * No override is needed any more: the browser is launched without a proxy, so a
     * context that says nothing simply egresses directly. The previous `direct://`
     * override existed only to escape the launch sentinel and did not actually work —
     * it failed page navigation outright, and `context.request` tried to resolve a
     * host literally named `direct`.
     */
    const context = await browser.newContext({
      ...contextOptions({ storageState }),
      ...(proxy ? { proxy } : {}),
    });
    context.setDefaultTimeout(config.NAV_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(config.NAV_TIMEOUT_MS);

    let blocking = { stats: () => ({}) };
    if (config.BLOCK_RESOURCES) {
      blocking = await installResourceBlocking(context, { blockStylesheets, extraAllow });
    }

    this.#contexts.add(context);
    log.debug({ acquireMs: Math.round(performance.now() - started) }, 'context acquired');

    return {
      context,
      driver: this.#driverName,
      channel: this.#channel,
      persistent: false,
      blockingStats: blocking.stats,
      release: async () => {
        this.#contexts.delete(context);
        await context.close().catch(() => {});
      },
    };
  }

  /**
   * Persistent-profile context, for real carriers.
   *
   * Trades the warm browser for a genuine on-disk Chrome profile. Two payoffs:
   * Patchright documents persistent contexts as its most undetectable mode, and
   * the profile keeps cookies, cache and device-trust markers across runs, so a
   * carrier that offers "remember this device" can actually remember it and we
   * skip MFA on subsequent pulls.
   *
   * Cost is real: a full browser launch per session, and profiles are
   * machine-local so they do not survive a redeploy. The encrypted
   * storageState store is the portable counterpart.
   */
  async acquirePersistentContext({
    profileKey,
    proxy = null,
    blockStylesheets = false,
    extraAllow = [],
  }) {
    const chromium = await this.#loadDriver();
    const dir = path.join(
      path.resolve(config.DATA_DIR),
      'profiles',
      crypto.createHmac('sha256', config.sessionEncryptionKey).update(profileKey).digest('hex').slice(0, 32)
    );
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    const base = launchOptions({ proxy });
    const attempts = [
      { ...base, channel: 'chrome' },
      { ...base, channel: 'chromium' },
      { ...base, channel: undefined },
    ];

    let context;
    let usedChannel;
    let lastErr;
    const started = performance.now();
    for (const opts of attempts) {
      try {
        context = await chromium.launchPersistentContext(dir, {
          ...opts,
          ...contextOptions(),
        });
        usedChannel = opts.channel ?? 'bundled-chromium';
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!context) throw new Error(`Could not launch persistent context: ${lastErr?.message}`);

    context.setDefaultTimeout(config.NAV_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(config.NAV_TIMEOUT_MS);

    let blocking = { stats: () => ({}) };
    if (config.BLOCK_RESOURCES) {
      blocking = await installResourceBlocking(context, { blockStylesheets, extraAllow });
    }

    this.#contexts.add(context);
    log.info(
      { channel: usedChannel, launchMs: Math.round(performance.now() - started) },
      'persistent context acquired'
    );

    return {
      context,
      driver: this.#driverName,
      channel: usedChannel,
      persistent: true,
      profileDir: dir,
      blockingStats: blocking.stats,
      release: async () => {
        this.#contexts.delete(context);
        await context.close().catch(() => {});
      },
    };
  }

  async shutdown() {
    this.#closed = true;
    for (const ctx of this.#contexts) await ctx.close().catch(() => {});
    this.#contexts.clear();
    await this.#browser?.close().catch(() => {});
    this.#browser = null;
    log.info('browser pool shut down');
  }
}

export const browserPool = new BrowserPool();
export default browserPool;
