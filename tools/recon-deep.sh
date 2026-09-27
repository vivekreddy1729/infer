#!/usr/bin/env bash
# Deeper read-only recon on the shortlisted carriers.
# Dumps: final URL, server/CDN headers, set-cookie names, external script hosts.
# Goal: distinguish "SPA shell that lazy-loads Akamai" from "genuinely light".

UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"

deep () {
  local name="$1" url="$2"
  echo "=============================================================="
  echo "### $name  ->  $url"
  curl -sS -L --max-time 25 -A "$UA" \
       -H 'Accept: text/html,application/xhtml+xml' \
       -H 'Accept-Language: en-US,en;q=0.9' \
       -D /tmp/dh.$$ -o /tmp/db.$$ \
       -w 'final_url=%{url_effective}\nhttp=%{http_code}\ntime=%{time_total}s\n' "$url" 2>/dev/null

  echo "--- infra headers ---"
  grep -iE '^(server|x-akamai|x-cdn|x-cache|via|cf-|x-amz-cf|x-served-by|x-powered-by|content-security-policy):' /tmp/dh.$$ \
    | cut -c1-160 | head -12
  echo "--- set-cookie names ---"
  grep -i '^set-cookie:' /tmp/dh.$$ | sed -E 's/^[Ss]et-[Cc]ookie: *([^=]+)=.*/  \1/' | sort -u | head -20
  echo "--- external script hosts ---"
  grep -oE 'src="https?://[^"/]+' /tmp/db.$$ | sed 's/src="https\?:\/\///' | sort | uniq -c | sort -rn | head -12
  echo "--- inline bot/api hints ---"
  grep -oiE '(/akam/[a-z0-9/._-]*|bmak|_abck|graphql|/api/[a-z0-9/._-]{3,40}|oauth2?/[a-z0-9/._-]{3,30}|/token|okta|auth0|ping(one|federate)|forgerock|/login-ui/|recaptcha/(api|enterprise))' /tmp/db.$$ \
    | tr 'A-Z' 'a-z' | sort | uniq -c | sort -rn | head -18
  rm -f /tmp/dh.$$ /tmp/db.$$
  echo
}

deep progressive "https://account.apps.progressive.com/access/ez/login"
deep geico       "https://ecams.geico.com/login"
deep travelers   "https://signin.travelers.com/"
deep hugo        "https://app.withhugo.com/login"
deep lemonade    "https://www.lemonade.com/login"
deep root        "https://my.joinroot.com/login"
