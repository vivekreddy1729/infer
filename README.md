# Carrier Policy Puller

A web app that signs into an insurance carrier's customer portal on the user's behalf,
walks them through multi-factor authentication interactively, finds the right policy
document, and returns the PDF.

Two real carriers are implemented and verified end to end:

| Carrier | Portal stack | MFA |
|---|---|---|
| **Progressive** | Angular + PingFederate | Emailed / texted code |
| **GEICO** | Flutter Web behind Imperva | Texted or emailed code, with a destination chooser |

There is also a built-in **demo portal** that imitates a carrier, so the whole flow can be
exercised without real credentials.

## What it actually does

1. You pick a carrier and enter your portal credentials.
2. It opens a real Chrome browser server-side and signs in.
3. When the carrier challenges for a code, the app asks **you** for it over a WebSocket and
   holds the browser session open while you go and read your phone.
4. It submits the code, locates the current policy document, and downloads the PDF.
5. The PDF is served back to your browser.

Progress streams live the whole way through, with per-step timings.

Two properties are worth knowing up front, because they drive most of the design:

- **A pull holds an open browser session in memory while it waits on a human.** That means
  the process is stateful, and it does not scale horizontally — one instance only.
- **It runs a headed browser, not headless.** GEICO's sign-in endpoint returns `302` headless
  and `200` headed, so this is a requirement rather than a preference.

## What you need

| Requirement | Notes |
|---|---|
| **Node.js 20+** | `.nvmrc` pins 20. |
| **Git** | To clone. |
| **A browser** | Installed by `npm run setup`. Real Chrome is preferred over bundled Chromium — see below. |
| **A residential proxy** | Only for real carriers. Carrier portals block datacenter IPs, so this is required once hosted, and unnecessary for the demo portal. |

Nothing else. No database, no Redis, no external services.

## Install the prerequisites

Skip this if `node --version` already prints 20 or higher.

**macOS**
```bash
brew install node git
```

**Ubuntu / Debian**
```bash
sudo apt update && sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

**Amazon Linux 2023**
```bash
sudo dnf install -y git
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs
```

**Windows / Windows Server** — a stock Windows Server AMI has neither, and there is no `winget`
on Server by default, so install Chocolatey first:
```powershell
# PowerShell as Administrator
Set-ExecutionPolicy Bypass -Scope Process -Force
[System.Net.WebClient]::new().DownloadString('https://community.chocolatey.org/install.ps1') | iex
choco install -y nodejs-lts git googlechrome
```
Open a new shell afterwards so `PATH` picks them up.

Confirm before continuing:
```bash
node --version    # must be 20+
git --version
```

## Running it

```bash
git clone https://github.com/vivekreddy1729/infer.git
cd infer

npm install
npm run setup     # installs Chromium (~500MB, the slow part), creates .env and data/ logs/
npm start
```

Then open <http://localhost:3000> and use the **demo portal** carrier. It needs no credentials
and no proxy, and it exercises the whole pipeline.

`npm run setup` is non-interactive and safe to re-run. It will not overwrite an existing
`.env`, and it finishes by running `npm run doctor`, so anything missing is reported there.

### Check the environment

```bash
npm run doctor
```

Reports Node version, whether `.env` is valid, which browser will actually be used, and
whether a proxy is configured. Run this first if anything misbehaves.

### Run the tests

```bash
npm run smoke:all
```

202 checks, end to end over the real transport against the demo portal. No credentials and no
network egress needed.

### Running it on a server

The three commands above prove the app runs on a box. They do not make it stay up or be
reachable. On a cloud instance you also need to:

- **Open the port** — both the cloud security group *and* the host firewall. Otherwise it is
  reachable only from the instance itself.
- **Put TLS in front of it.** Users type carrier credentials into this app; do not serve it over
  plain HTTP across the internet.
- **Supervise the process**, or it dies when your session ends and does not return after a
  reboot. On **Windows** this cannot be a Windows Service: the app runs a *headed* browser,
  headed Chrome needs an interactive desktop, and Windows Services get Session 0, which has
  none. Use auto-logon plus a scheduled task set to "run only when user is logged on".
- **Configure a residential proxy.** A datacenter IP is the one thing carriers reject before
  anything else.
- **Run exactly one instance.** A pull holds an open browser session in memory, so a second
  instance can receive a WebSocket for a browser it is not holding.

## Using it against a real carrier

Three things to set in `.env`:

```bash
HEADLESS=false              # required — GEICO returns 302 headless
SESSION_ENCRYPTION_KEY=...  # 32 bytes of hex; npm run setup generates one
RESIDENTIAL_PROXY_URL=...   # http://user:pass@host:port
```

Then verify the proxy actually holds one IP for the length of a pull, **before** spending a
real login on it — a failed attempt counts against carrier lockout limits:

```bash
npm run proxy:verify
```

Two more things that are easy to get wrong:

- **Install real Chrome.** `npx playwright install chrome`. The code prefers it and silently
  falls back to bundled Chromium, which is a weaker anti-detection posture. `npm run doctor`
  tells you which one is in use.
- **Leave `PROXY_USERNAME_TEMPLATE` unset** unless your proxy is a *rotating gateway*. On a
  dedicated-IP plan it rewrites a username the provider expects verbatim, and the resulting
  auth failure looks exactly like a blocked IP. Set `PROXY_MODEL` to `dedicated` or
  `rotating` and `doctor` will check the combination for you.

Carrier credentials are held in memory for the duration of one pull, zeroed afterwards, and
never written to disk or to a log line. Saved *sessions* are a different matter — they are
encrypted at rest under `SESSION_ENCRYPTION_KEY`, and `data/` should be treated as secret.

## Useful commands

| Command | What it does |
|---|---|
| `npm start` | Run the server. |
| `npm run dev` | Run with auto-reload. |
| `npm run restart` | Restart and *verify* it restarted — checks the port holder, that only one server is up, and that no source file is newer than the running process. |
| `npm run doctor` | Preflight check. |
| `npm run smoke:all` | Full test suite. |
| `npm run proxy:verify` | Prove the proxy is sticky before trusting it. |
| `npm run proxy:discover` | Read a Proxy-Cheap account and print the `.env` lines it implies. |
| `npm run audit:secrets` | Scan working files for anything credential-shaped. |
| `npm run profiles:clear` | Delete saved browser profiles. Next run takes a cold login. |

## Layout

```
src/
  server.js          HTTP + WebSocket entry point
  carriers/          one self-contained adapter per carrier
    progressive.js
    geico/           isolated — shares no code with progressive
    mockCarrier.js   the demo portal's adapter
  session/           the pull state machine, credential handling
  browser/           browser pool, proxy, stealth, egress reporting
  storage/           encrypted session store
public/              frontend
tools/               setup, doctor, tests, probes, proxy utilities
```

Carrier adapters are deliberately isolated from each other — a change to one cannot break
another. `npm run check:isolation` enforces it by parsing imports, and runs as part of
`smoke:all`.

## Configuration

Every setting is documented inline in [`.env.example`](.env.example), including which ones
are required for real carriers and which failure each defends against.

## Notes

- Ports: the app serves on `3000` by default (`PORT`).
- Logs go to `logs/`, written by the application rather than by shell redirection. A
  redacted diagnostic bundle is written to `logs/failures/` on any failed pull — safe to
  share, since credentials, codes, cookies and tokens are stripped at the logger.
- `data/` holds the encrypted session store and browser profiles. Treat it as secret: a
  browser profile is equivalent to a logged-in session.
