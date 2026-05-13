#!/usr/bin/env sh
# ---------------------------------------------------------------
# Opsling installer
#
# Usage:
#   curl -fsSL https://opsling.dev/install.sh | sh
#   curl -fsSL https://opsling.dev/install.sh | sh -s -- [flags]
#
# Flags:
#   --skip-setup           Don't prompt; just prepare files and exit
#   --start                Force start at the end (assumes .env is filled)
#   --skip-cli             Don't install the 'opsling' helper command
#   --skip-pull            Don't run "docker compose pull" (useful for local
#                          testing with a pre-built image)
#   --bot-token VALUE      Set TELEGRAM_BOT_TOKEN in .env
#   --chat-id   VALUE      Set TELEGRAM_CHAT_ID in .env
#   --set KEY=VALUE        Set any env var in .env  (repeatable)
#   -h, --help             Show this help
#
# Examples:
#   curl ... | sh -s -- --bot-token xxx --chat-id yyy
#   curl ... | sh -s -- --bot-token xxx --chat-id yyy \
#                       --set CPU_THRESHOLD=90 \
#                       --set IGNORE_CONTAINERS=opsling,traefik
#
# Env vars (consumed by the installer itself):
#   OPSLING_DIR            Install directory
#                            (root default:     /opt/opsling)
#                            (non-root default: $HOME/.opsling)
#   OPSLING_VERSION        Image tag to pin (default: latest)
#   OPSLING_REPO           Raw-content URL prefix
#   OPSLING_CLI_DIR        Helper CLI install dir
#                            (root default:     /usr/local/bin)
#                            (non-root default: $HOME/.local/bin)
#
# Env-var pre-seed (only works if you EXPORT them first — a plain
# "VAR=x curl | sh" does NOT pass VAR to sh, only to curl):
#   export TELEGRAM_BOT_TOKEN=...
#   export TELEGRAM_CHAT_ID=...
#   curl ... | sh
# CLI flags are the recommended path.
# ---------------------------------------------------------------
set -eu

# Pick defaults based on whether we're root. Root → FHS layout (system-wide);
# non-root → home-dir layout (no sudo needed, works the same on Mac and Linux).
# Either can be overridden by setting OPSLING_DIR / OPSLING_CLI_DIR explicitly.
if [ "$(id -u)" -eq 0 ]; then
  _DEFAULT_DIR=/opt/opsling
  _DEFAULT_CLI_DIR=/usr/local/bin
else
  _DEFAULT_DIR="${HOME:-/tmp}/.opsling"
  _DEFAULT_CLI_DIR="${HOME:-/tmp}/.local/bin"
fi

OPSLING_DIR="${OPSLING_DIR:-$_DEFAULT_DIR}"
OPSLING_VERSION="${OPSLING_VERSION:-latest}"
OPSLING_REPO="${OPSLING_REPO:-https://raw.githubusercontent.com/go-native/opsling/main}"
OPSLING_CLI_DIR="${OPSLING_CLI_DIR:-$_DEFAULT_CLI_DIR}"

SKIP_SETUP=false
AUTO_START=false
SKIP_CLI=false
SKIP_PULL=false

# Collect --set values (and --bot-token / --chat-id sugar) into a temp file —
# POSIX sh has no real arrays. Applied after .env is in place.
PRESEED_FILE="$(mktemp)"
trap 'rm -f "$PRESEED_FILE"' EXIT INT TERM

preseed_add() {
  # $1 = KEY, $2 = VALUE
  printf '%s\n' "$1=$2" >> "$PRESEED_FILE"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-setup) SKIP_SETUP=true; shift ;;
    --start)      AUTO_START=true; shift ;;
    --skip-cli)   SKIP_CLI=true; shift ;;
    --skip-pull)  SKIP_PULL=true; shift ;;
    --bot-token)
      [ $# -ge 2 ] || { printf '%s\n' '--bot-token needs a value' >&2; exit 1; }
      preseed_add TELEGRAM_BOT_TOKEN "$2"
      shift 2 ;;
    --chat-id)
      [ $# -ge 2 ] || { printf '%s\n' '--chat-id needs a value' >&2; exit 1; }
      preseed_add TELEGRAM_CHAT_ID "$2"
      shift 2 ;;
    --set)
      [ $# -ge 2 ] || { printf '%s\n' '--set needs KEY=VALUE' >&2; exit 1; }
      case "$2" in
        *=*) printf '%s\n' "$2" >> "$PRESEED_FILE"; shift 2 ;;
        *)   printf '--set value must be KEY=VALUE (got: %s)\n' "$2" >&2; exit 1 ;;
      esac
      ;;
    -h|--help)
      grep -E '^# ' "$0" | sed 's/^# //;s/^#$//'
      exit 0
      ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done

# ---------- output helpers ----------
c_red()   { printf '\033[31m%s\033[0m' "$1"; }
c_green() { printf '\033[32m%s\033[0m' "$1"; }
c_cyan()  { printf '\033[36m%s\033[0m' "$1"; }
c_yellow(){ printf '\033[33m%s\033[0m' "$1"; }
c_dim()   { printf '\033[2m%s\033[0m' "$1"; }
c_bold()  { printf '\033[1m%s\033[0m' "$1"; }

err() { printf '%s %s\n' "$(c_red '✖')" "$1" >&2; exit 1; }
ok()  { printf '%s %s\n' "$(c_green '✔')" "$1"; }
say() { printf '%s %s\n' "$(c_cyan '·')" "$1"; }
warn(){ printf '%s %s\n' "$(c_yellow '!')" "$1"; }

# ---------- interactive detection ----------
# When piped (curl|sh), stdin is the curl pipe — not a TTY. We fall back to
# /dev/tty so prompts still work in that case.
if [ -t 0 ]; then
  IS_INTERACTIVE=true
  TTY_IN=/dev/stdin
elif [ -r /dev/tty ] && [ -w /dev/tty ]; then
  IS_INTERACTIVE=true
  TTY_IN=/dev/tty
else
  IS_INTERACTIVE=false
  TTY_IN=
fi

prompt_secret() {
  # $1 = label
  local label="$1"
  local value=''
  if [ "$IS_INTERACTIVE" = false ]; then
    return 1
  fi
  printf '%s ' "$(c_bold "$label:")" > /dev/tty
  IFS= read -r value < "$TTY_IN" || return 1
  printf '%s\n' "$value"
}

# ---------- env-file helpers ----------
read_env_var() {
  # $1 = key, $2 = file
  [ -f "$2" ] || { printf ''; return; }
  grep "^${1}=" "$2" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

set_env_var() {
  # $1 = key, $2 = value, $3 = file
  local key="$1" value="$2" file="$3"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    # use a portable in-place replace
    local tmp
    tmp="$(mktemp)"
    awk -v k="$key" -v v="$value" '
      BEGIN { set = 0 }
      $0 ~ "^"k"=" { print k"="v; set = 1; next }
      { print }
      END { if (!set) print k"="v }
    ' "$file" > "$tmp"
    mv "$tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

need() {
  command -v "$1" >/dev/null 2>&1 || err "'$1' is required but not installed."
}

# ---------- steps ----------
main() {
  printf '\n%s\n\n' "$(c_cyan '=== Opsling installer ===')"

  # 1. dependency checks
  need docker
  if ! docker compose version >/dev/null 2>&1; then
    err "docker compose v2 is required (got: $(docker --version 2>/dev/null || echo none))"
  fi
  ok "docker and docker compose detected"

  # 2. install dir
  if [ ! -d "$OPSLING_DIR" ]; then
    say "creating $OPSLING_DIR"
    if ! mkdir -p "$OPSLING_DIR" 2>/dev/null; then
      err "could not create $OPSLING_DIR — re-run with sudo, or set OPSLING_DIR=\$HOME/opsling"
    fi
  fi
  cd "$OPSLING_DIR"

  # 3. drop .env (idempotent)
  if [ ! -f .env ]; then
    say "downloading .env template"
    curl -fsSL "$OPSLING_REPO/.env.example" -o .env || err "failed to download .env.example"
    chmod 600 .env
    ok ".env created at $OPSLING_DIR/.env"
  else
    ok ".env already exists — leaving it untouched"
  fi

  # 4. drop docker-compose.yml.
  #    On Linux: download the full compose (host bind mount + HOST_FS_ROOT for
  #              accurate disk monitoring).
  #    On macOS: Docker Desktop's VM doesn't satisfy the rslave propagation
  #              requirement, and the disk numbers would be from the VM anyway,
  #              not the Mac. Write a simplified compose without the host bind.
  if [ "$(uname -s)" = "Darwin" ]; then
    say "macOS detected — using simplified compose (no host bind mount)"
    cat > docker-compose.yml <<EOF
services:
  opsling:
    image: ghcr.io/go-native/opsling:${OPSLING_VERSION}
    container_name: opsling
    restart: unless-stopped
    env_file: .env
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    ports:
      - "127.0.0.1:4717:4717"
EOF
  else
    say "downloading docker-compose.yml"
    curl -fsSL "$OPSLING_REPO/docker/docker-compose.yml" -o docker-compose.yml \
      || err "failed to download docker-compose.yml"

    if [ "$OPSLING_VERSION" != "latest" ]; then
      say "pinning image to $OPSLING_VERSION"
      sed -i.bak "s|opsling:latest|opsling:${OPSLING_VERSION}|" docker-compose.yml
      rm -f docker-compose.yml.bak
    fi
  fi

  # 5a. apply CLI pre-seed (--bot-token / --chat-id / --set KEY=VALUE)
  if [ -s "$PRESEED_FILE" ]; then
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      _key="${line%%=*}"
      _value="${line#*=}"
      case "$_key" in
        *[!A-Za-z0-9_]*|"")
          warn "skipping invalid --set key: $_key"
          continue
          ;;
      esac
      set_env_var "$_key" "$_value" .env
      case "$_key" in
        *TOKEN*|*SECRET*|*PASSWORD*|*API_KEY*) ok "$_key set (value hidden)" ;;
        *) ok "$_key=$_value" ;;
      esac
    done < "$PRESEED_FILE"
  fi

  # 5b. wizard for any still-missing required values
  bot_token="$(read_env_var TELEGRAM_BOT_TOKEN .env)"
  chat_id="$(read_env_var TELEGRAM_CHAT_ID .env)"
  # exported env vars beat whatever is in .env (only works if user actually exported)
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && bot_token="$TELEGRAM_BOT_TOKEN"
  [ -n "${TELEGRAM_CHAT_ID:-}" ]   && chat_id="$TELEGRAM_CHAT_ID"

  if [ "$SKIP_SETUP" = false ] && [ "$IS_INTERACTIVE" = true ]; then
    if [ -z "$bot_token" ]; then
      printf '\n%s\n' "$(c_bold 'Telegram setup')"
      printf '%s\n' "$(c_dim 'Create a bot with @BotFather and grab your chat id from')"
      printf '%s\n\n' "$(c_dim 'https://api.telegram.org/bot<TOKEN>/getUpdates')"
      bot_token="$(prompt_secret 'TELEGRAM_BOT_TOKEN' || true)"
    fi
    if [ -z "$chat_id" ]; then
      chat_id="$(prompt_secret 'TELEGRAM_CHAT_ID' || true)"
    fi
  fi

  if [ -n "$bot_token" ]; then
    set_env_var TELEGRAM_BOT_TOKEN "$bot_token" .env
    ok 'TELEGRAM_BOT_TOKEN saved to .env'
  fi
  if [ -n "$chat_id" ]; then
    set_env_var TELEGRAM_CHAT_ID "$chat_id" .env
    ok 'TELEGRAM_CHAT_ID saved to .env'
  fi
  chmod 600 .env

  # 6. pull image (skippable for local/offline testing)
  if [ "$SKIP_PULL" = true ]; then
    warn 'skipping docker compose pull (--skip-pull)'
  else
    say "pulling image"
    docker compose pull || err "docker compose pull failed"
  fi

  # 7. install opsling helper CLI
  if [ "$SKIP_CLI" = false ]; then
    if [ ! -d "$OPSLING_CLI_DIR" ]; then
      mkdir -p "$OPSLING_CLI_DIR" 2>/dev/null || true
    fi
    if [ -w "$OPSLING_CLI_DIR" ] || [ "$(id -u)" -eq 0 ]; then
      say "installing 'opsling' helper to $OPSLING_CLI_DIR/opsling"
      curl -fsSL "$OPSLING_REPO/scripts/opsling" -o "$OPSLING_CLI_DIR/opsling" \
        && chmod +x "$OPSLING_CLI_DIR/opsling" \
        && ok "'opsling' command installed"
      case ":${PATH}:" in
        *":$OPSLING_CLI_DIR:"*) : ;;
        *)
          warn "$OPSLING_CLI_DIR is not on your PATH"
          warn "  add this to your shell rc file (e.g. ~/.zshrc):"
          warn "    export PATH=\"$OPSLING_CLI_DIR:\$PATH\""
          ;;
      esac
    else
      warn "no write access to $OPSLING_CLI_DIR — skipping helper CLI install"
      warn "  (re-run with sudo, or set OPSLING_CLI_DIR=\$HOME/.local/bin)"
    fi
  fi

  # 8. start if we have creds (or --start was passed)
  if [ "$AUTO_START" = true ] || { [ -n "$bot_token" ] && [ -n "$chat_id" ]; }; then
    say "starting opsling"
    docker compose up -d || err "docker compose up failed"
    printf '\n%s\n\n' "$(c_green '=== opsling is running ===')"
    printf 'Useful commands:\n'
    printf '  %s    %s\n' "$(c_bold 'opsling status')"    "$(c_dim '— show container state')"
    printf '  %s   %s\n'  "$(c_bold 'opsling logs -f')"   "$(c_dim '— tail logs')"
    printf '  %s    %s\n' "$(c_bold 'opsling update')"    "$(c_dim '— pull + restart')"
    printf '  %s    %s\n' "$(c_bold 'opsling config')"    "$(c_dim '— edit .env')"
    printf '  %s %s\n'    "$(c_bold 'opsling uninstall')" "$(c_dim '— stop + remove install dir')"
    printf '\n'
  else
    printf '\n%s\n\n' "$(c_green '=== installed (not yet started) ===')"
    printf 'Finish setup:\n'
    printf '  1. %s\n'  "$(c_dim "edit $OPSLING_DIR/.env  (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)")"
    printf '  2. %s\n\n' "$(c_dim 'opsling up   (or: cd '"$OPSLING_DIR"' && docker compose up -d)')"
  fi
}

main "$@"
