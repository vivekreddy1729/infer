/**
 * Persistent "this is the IP we're using" badge, on every page.
 *
 * ------------------------------------------------------------------------
 * WHY IT SHOWS WHAT IT SHOWS
 * ------------------------------------------------------------------------
 * There are two IPs in this system and only one is worth displaying:
 *
 *   the Node process egress   — this host's own address, does not traverse the proxy
 *   the browser exit IP        — what carrier traffic actually leaves from
 *
 * This shows the second. A badge reading "we are using 73.x.x.x" while the carrier sees
 * a different address would be consulted during exactly the debugging session where
 * being wrong costs the most.
 *
 * ------------------------------------------------------------------------
 * WHY IT POLLS THE WAY IT DOES
 * ------------------------------------------------------------------------
 * Measuring the browser's exit costs an HTTPS request *through the proxy*, and
 * residential bandwidth is metered at roughly $4/GB. So:
 *
 *   - the first paint uses `?probe=0` — cache only, no proxy traffic, instant
 *   - the poll is 30s, but the server serves a 5-minute cache, so N open tabs cause
 *     at most one probe per 5 minutes between them
 *   - a real measurement happens only on an explicit click
 *
 * Injected by script rather than duplicated into each page's markup, so there is one
 * place to change it and no chance of the two pages disagreeing.
 *
 * Included by both index.html and metrics.html.
 */

(() => {
  const POLL_MS = 30_000;

  const el = document.createElement('div');
  el.id = 'egress-badge';
  el.setAttribute('role', 'status');
  // Polite: this updates in the background and must not interrupt a screen reader
  // mid-sentence while someone is filling in the credential form.
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `
    <span class="eb-dot" aria-hidden="true"></span>
    <span class="eb-body">
      <span class="eb-label">egress</span>
      <span class="eb-ip">checking…</span>
    </span>
    <button type="button" class="eb-refresh" title="Measure the exit IP now (uses a little proxy bandwidth)">↻</button>
  `;

  const dot = el.querySelector('.eb-dot');
  const ipEl = el.querySelector('.eb-ip');
  const labelEl = el.querySelector('.eb-label');
  const refreshBtn = el.querySelector('.eb-refresh');

  const ageText = (ms) => {
    if (ms == null) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    return `${m}m ago`;
  };

  function render(d) {
    if (!d) {
      el.dataset.state = 'unknown';
      labelEl.textContent = 'egress';
      ipEl.textContent = 'unavailable';
      el.title = 'Could not reach the server for egress status.';
      return;
    }

    const proxied = d.mode === 'proxy';
    const live = d.source === 'live-session';

    /**
     * The state drives the colour, and `direct` is deliberately a warning rather than
     * neutral. Running without a proxy is the single most likely reason a real carrier
     * pull fails once deployed, and a continuously visible amber is more useful than a
     * startup log line nobody re-reads.
     */
    el.dataset.state = !proxied ? 'direct' : d.ip ? (live ? 'live' : 'proxy') : 'proxy-unknown';

    if (!proxied) {
      /**
       * Show the address even with no proxy — it is still the answer.
       *
       * With no proxy the browser egresses exactly as this host does, so this IS what
       * the carrier sees. The label says "direct" and the dot is amber, which carries
       * the warning; withholding the number would remove the most useful fact on the
       * badge to make a point the colour already makes.
       */
      labelEl.textContent = 'direct · no proxy';
      ipEl.textContent = d.ip ?? 'IP unknown';
    } else if (d.ip) {
      labelEl.textContent = live ? `via proxy · ${d.carrierId ?? 'live'}` : 'via proxy';
      // Full address, not masked. It is the operator's own infrastructure and the
      // point of the badge is to be able to compare it against a carrier's logs.
      ipEl.textContent = d.ip;
    } else {
      labelEl.textContent = 'via proxy';
      ipEl.textContent = 'IP unknown';
    }

    const bits = [d.note];
    if (d.ip && !live) bits.push(`Measured ${ageText(d.ageMs)}${d.service ? ` via ${d.service}` : ''}.`);
    if (live) bits.push('This is the pull running right now, so it is what the carrier sees.');
    if (d.stale) bits.push('Cached value — click ↻ to measure again.');
    el.title = bits.filter(Boolean).join('\n');
  }

  async function load({ probe = false } = {}) {
    try {
      const res = await fetch(`/api/egress${probe ? '' : '?probe=0'}`, { cache: 'no-store' });
      render(res.ok ? await res.json() : null);
    } catch {
      render(null);
    }
  }

  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    ipEl.textContent = 'measuring…';
    el.dataset.state = 'busy';
    await load({ probe: true });
    refreshBtn.disabled = false;
  });

  function start() {
    document.body.appendChild(el);
    load({ probe: false });
    /**
     * Pause polling while the tab is hidden.
     *
     * A background tab left open overnight would otherwise keep asking. Cheap because
     * the server caches, but pointless, and it keeps the log free of thousands of
     * requests nobody read.
     */
    let timer = setInterval(() => { if (!document.hidden) load({ probe: false }); }, POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) load({ probe: false });
    });
    window.addEventListener('beforeunload', () => clearInterval(timer));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
