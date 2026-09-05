#!/usr/bin/env bash
# Financial Brain preflight. Reads the machine, changes nothing.
# Every line is a read. No installs, no writes, no credentials printed.
ok(){ printf "  ok    %s\n" "$1"; }
warn(){ printf "  WARN  %s\n" "$1"; WARNED=$((WARNED+1)); }
stop(){ printf "  STOP  %s\n" "$1"; STOPPED=$((STOPPED+1)); }
WARNED=0; STOPPED=0; FRESH=0; NOMANIFEST=0
echo "Financial Brain preflight  -  $(date '+%Y-%m-%d %H:%M')"
echo

echo "MACHINE"
printf "  os              %s %s\n" "$(uname -s)" "$(uname -r)"
if command -v node >/dev/null 2>&1; then
  NV=$(node -v); NMAJ=${NV#v}; NMAJ=${NMAJ%%.*}
  printf "  node            %s (%s)\n" "$NV" "$(command -v node)"
  [ "$NMAJ" -ge 22 ] 2>/dev/null || stop "node $NV is too old; the installer needs 22 or newer"
else stop "node is not installed"; fi
command -v npm >/dev/null 2>&1 && printf "  npm             %s\n" "$(npm -v 2>/dev/null)" || stop "npm is not installed"
echo

echo "THE BRAIN CLI"
# This script is Bash, so use Bash's portable all-PATH lookup. `command -v -a`
# is not a valid Bash command and silently made every machine look fresh.
COPIES=$(type -a -P brain 2>/dev/null | sort -u)
N=$(printf "%s" "$COPIES" | grep -c . )
if [ "$N" -eq 0 ]; then
  FRESH=1; warn "no 'brain' on PATH (fine before a first install; call it by full path otherwise)"
elif [ "$N" -eq 1 ]; then
  ok "resolves to $COPIES"
else
  stop "$N copies of 'brain' on PATH; the first one wins and it may not be the one you updated"
  printf "%s\n" "$COPIES" | sed 's/^/          /'
fi
if command -v npm >/dev/null 2>&1; then
  PFX=$(npm config get prefix 2>/dev/null)
  printf "  npm prefix      %s\n" "$PFX"
  [ -n "$COPIES" ] && case "$COPIES" in "$PFX"*) : ;; *) warn "the CLI is NOT under the npm prefix; a plain 'npm i -g' will install somewhere else and leave the old one running" ;; esac
fi
echo

echo "CLOUDFLARE ACCESS"
if [ -n "$CLOUDFLARE_API_TOKEN" ]; then
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 12 https://api.cloudflare.com/client/v4/accounts -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
  if [ "$CODE" = "200" ]; then ok "CLOUDFLARE_API_TOKEN is set and works"
  else stop "CLOUDFLARE_API_TOKEN is set but REJECTED (http $CODE). It beats the browser sign-in and disables session renewal. Unset it."; fi
else ok "no CLOUDFLARE_API_TOKEN in the environment (browser sign-in will be used)"; fi
WFORMAT=""
# Match operations/wrangler-oauth.mjs exactly. Inspect files, not merely an
# earlier directory, so an empty directory cannot hide a usable later session.
WCFG_CANDIDATES=("$HOME/.config/.wrangler/config" "$HOME/.wrangler/config")
if [ -n "$XDG_CONFIG_HOME" ]; then
  WCFG_CANDIDATES=("$XDG_CONFIG_HOME/.wrangler/config" "${WCFG_CANDIDATES[@]}")
fi
for WCFG in "${WCFG_CANDIDATES[@]}"; do
  if [ -f "$WCFG/default.toml" ]; then WFORMAT="toml"; break
  elif [ -f "$WCFG/default.enc" ]; then WFORMAT="encrypted"; break
  fi
done
if [ "$WFORMAT" = "toml" ]; then ok "wrangler session found (default.toml, the format the installer reads)"
elif [ "$WFORMAT" = "encrypted" ]; then stop "wrangler wrote default.enc, which the installer cannot read. Sign in with: npx wrangler@4.73.0 login"
else warn "no wrangler session yet. Sign in with: npx wrangler@4.73.0 login"; fi
echo

echo "NETWORK"
for pair in "api.github.com|https://api.github.com" "github.com|https://github.com" "release assets|https://release-assets.githubusercontent.com"; do
  H=${pair%%|*}; U=${pair##*|}
  C=$(curl -s -o /dev/null -w '%{http_code}' -m 12 "$U" 2>/dev/null)
  case "$C" in 2*|3*|4*) ok "$H reachable (http $C)" ;; *) stop "$H unreachable (http ${C:-000}); the download will fail" ;; esac
done
echo

echo "RELEASE"
LATEST=$(curl -s -m 15 https://api.github.com/repos/guldanjaMAX/brain-installer/releases/latest | grep -o '"tag_name": *"[^"]*"' | cut -d'"' -f4)
[ -n "$LATEST" ] && ok "current release is $LATEST" || warn "could not read the current release"
if [ "$N" -ge 1 ] && command -v npm >/dev/null 2>&1; then
  INST=$(npm ls -g --depth=0 2>/dev/null | sed -n 's/.*brain-installer@\([0-9.]*\).*/\1/p' | head -1)
  [ -n "$INST" ] && { printf "  installed       %s\n" "$INST"; [ "v$INST" = "$LATEST" ] || warn "installed $INST is not the current release $LATEST"; }
fi
echo

echo "MANIFESTS"
MF=$(find "$HOME" -maxdepth 4 -name brain.manifest.json -not -path "*/node_modules/*" -not -path "*/templates/*" -not -path "*/.*/*" 2>/dev/null)
MN=$(printf "%s" "$MF" | grep -c .)
if [ "$MN" -eq 0 ]; then NOMANIFEST=1; ok "no manifest yet (expected before a first install)"
elif [ "$MN" -eq 1 ]; then
  ok "one manifest: $MF"
  DOM=$(grep -o '"domain": *"[^"]*"' "$MF" 2>/dev/null | head -1 | cut -d'"' -f4)
  if [ -n "$DOM" ]; then
    H=$(curl -s -m 15 "https://$DOM/health" 2>/dev/null)
    ST=$(printf "%s" "$H" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
    AD=$(printf "%s" "$H" | grep -o '"accepting_documents":[a-z]*' | cut -d: -f2)
    case "$ST" in
      ok) ok "brain at $DOM is $ST, accepting_documents=$AD" ;;
      paused-for-upgrade) stop "brain at $DOM is PAUSED (an update did not finish). See /kit/known-issues" ;;
      "") warn "no answer from https://$DOM/health" ;;
      *) warn "brain at $DOM reports status=$ST" ;;
    esac
  fi
else
  stop "$MN manifests found; the wrong one will be picked. Ask which folder is theirs."
  printf "%s\n" "$MF" | sed 's/^/          /'
fi
echo
echo "-----"
if [ "$STOPPED" -gt 0 ]; then printf "%d thing(s) will stop the install, and %d worth knowing.\nClear the STOP lines first. Each one says what to do.\n" "$STOPPED" "$WARNED"; exit 1;
elif [ "$WARNED" -gt 0 ]; then
  if [ "$FRESH" = 1 ] && [ "$NOMANIFEST" = 1 ]; then
    printf "Nothing is wrong here. This is a machine before its first install,\nand every line above says so. Go ahead and start.\n";
  else printf "%d thing(s) to be aware of, none of them blocking. Read them, then carry on.\n" "$WARNED"; fi
  exit 0;
else echo "All clear."; exit 0; fi
