#!/usr/bin/env bash
# Read-only recon: fetch public login pages, fingerprint which anti-bot vendor is in front.
# No credentials, no POSTs. Purely identifying which carriers are tractable in a short build window.

UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"

probe () {
  local name="$1" url="$2"
  local out hdr body vendors
  out=$(curl -sS -L --max-time 25 -A "$UA" \
        -H 'Accept: text/html,application/xhtml+xml' \
        -H 'Accept-Language: en-US,en;q=0.9' \
        -D /tmp/h.$$ -o /tmp/b.$$ -w '%{http_code}' "$url" 2>/dev/null)
  hdr=$(cat /tmp/h.$$ 2>/dev/null)
  body=$(cat /tmp/b.$$ 2>/dev/null)
  vendors=""
  grep -qi '_abck\|bm_sz\|ak_bmsc\|/akam/\|akamai' <<<"$hdr$body" && vendors+="AKAMAI-BotManager "
  grep -qi 'datadome' <<<"$hdr$body" && vendors+="DATADOME "
  grep -qi '_px[A-Za-z0-9]*=\|perimeterx\|px-cdn\|captcha\.px' <<<"$hdr$body" && vendors+="PERIMETERX/HUMAN "
  grep -qi 'visid_incap\|incap_ses\|imperva' <<<"$hdr$body" && vendors+="IMPERVA "
  grep -qi '__cf_bm\|cf-ray\|cloudflare' <<<"$hdr$body" && vendors+="CLOUDFLARE "
  grep -qi 'shape-\|shapesecurity\|f5-\|_bm4h\|/f5-\|interstitial' <<<"$hdr$body" && vendors+="F5/SHAPE? "
  grep -qi 'recaptcha' <<<"$body" && vendors+="reCAPTCHA "
  grep -qi 'hcaptcha' <<<"$body" && vendors+="hCaptcha "
  grep -qi 'kasada\|kpsdk' <<<"$hdr$body" && vendors+="KASADA "
  [ -z "$vendors" ] && vendors="(none detected)"
  printf '%-16s %-4s  %-8s  %s\n' "$name" "$out" "$(wc -c </tmp/b.$$ | tr -d ' ')B" "$vendors"
  rm -f /tmp/h.$$ /tmp/b.$$
}

printf '%-16s %-4s  %-8s  %s\n' "CARRIER" "HTTP" "SIZE" "ANTI-BOT SIGNATURES"
printf '%s\n' "----------------------------------------------------------------------"
probe progressive   "https://account.apps.progressive.com/access/ez/login"
probe geico         "https://ecams.geico.com/login"
probe allstate      "https://myaccount.allstate.com/anon/account/login"
probe statefarm     "https://proofing.statefarm.com/login-ui/login"
probe lemonade      "https://www.lemonade.com/login"
probe root          "https://my.joinroot.com/login"
probe travelers     "https://signin.travelers.com/"
probe nationwide    "https://login.nationwide.com/access/web/login.htm"
probe libertymutual "https://account.libertymutual.com/sign-in"
probe erie          "https://www.erieinsurance.com/login"
probe kemper        "https://myaccount.kemper.com/"
probe mercury       "https://www.mercuryinsurance.com/login"
probe clearcover    "https://app.clearcover.com/login"
probe hugo          "https://app.withhugo.com/login"
probe farmers       "https://www.farmers.com/login/"
