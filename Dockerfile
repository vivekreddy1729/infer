# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Base: Microsoft's official Playwright image, pinned to the same version as the
# patchright dependency (1.63.0).
#
# Patchright is a fork of Playwright that tracks it release-for-release, and it
# speaks the same wire protocol to the same browser builds. A mismatch between
# the driver in node_modules and the browsers baked into the image produces
# "Executable doesn't exist" or protocol errors at launch, so these two version
# numbers must be changed together. They are pinned, not floating, for that
# reason.
#
# Using this image rather than node:22-slim + apt-get is worth ~40 lines of
# shared-library installs: Chrome needs nss, atk, cups, libdrm, pango, xkbcommon,
# and a dozen more that are easy to get subtly wrong.
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV NODE_ENV=production \
    # Keep browsers at the image's standard location so both the preinstalled
    # Playwright browsers and anything patchright downloads land in one place.
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app

# Dependency layer first so application edits do not invalidate the npm cache.
COPY package.json package-lock.json ./

# `npm ci --omit=dev` for a reproducible, production-only tree.
RUN npm ci --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# Browser binaries.
#
# The base image ships Playwright's browsers, but patchright resolves its own
# revision and will not necessarily accept them, so we install explicitly.
#
# Both Chrome and Chromium are installed on purpose, matching the launch
# fallback chain in browserPool.js:
#   chrome   -- real Google Chrome, the best stealth posture
#   chromium -- full Chromium, still avoids the chrome-headless-shell tell
# Installing only Chromium would silently cost us the preferred path in
# production while it worked locally, which is exactly the class of bug this
# whole exercise is about.
#
# `--with-deps` is omitted: the base image already carries the system libraries,
# and running it would re-run apt for nothing.
#
# There is deliberately no `chmod -R a+rx /ms-playwright` here. It is a common
# addition and it is both unnecessary and actively harmful: the installer already
# writes world-readable browsers, and recursing chmod over a ~500MB tree is slow
# and fails outright on storage drivers that report EIO partway through, taking
# the whole build with it.
# ---------------------------------------------------------------------------
RUN npx patchright install chromium \
 && npx patchright install chrome

COPY src ./src
COPY public ./public
COPY tools ./tools

# Volume mount point for encrypted session state and Chrome profiles. Owned by
# the unprivileged user the image already provides.
RUN mkdir -p /app/data && chown -R pwuser:pwuser /app

# Drop privileges. The container runs a browser that loads untrusted remote
# pages, so this is not ceremony.
USER pwuser

EXPOSE 3000

# Fails the healthcheck if the browser never came up, not merely if the HTTP
# port is listening. A process that serves 200s but cannot launch Chrome is not
# healthy for this workload.
HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>r.json()).then(h=>process.exit(h.browser&&h.browser.ready?0:1)).catch(()=>process.exit(1))"

# ---------------------------------------------------------------------------
# Xvfb entrypoint.
#
# HEADLESS=false is a meaningful anti-detection option: headed Chrome on a
# virtual display behaves like a real windowed browser, whereas even
# new-headless differs in ways detection vendors probe for. `xvfb-run` supplies
# the display; the base image already includes it.
#
# `docker-entrypoint.sh` chooses between headed-under-Xvfb and plain headless
# based on the env var, so switching modes is a config change and not a rebuild.
# ---------------------------------------------------------------------------
COPY --chown=pwuser:pwuser docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
