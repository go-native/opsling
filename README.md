<div align="center">

<pre>
 ██████╗ ██████╗ ███████╗██╗     ██╗███╗   ██╗ ██████╗ 
██╔═══██╗██╔══██╗██╔════╝██║     ██║████╗  ██║██╔════╝ 
██║   ██║██████╔╝███████╗██║     ██║██╔██╗ ██║██║  ███╗
██║   ██║██╔═══╝ ╚════██║██║     ██║██║╚██╗██║██║   ██║
╚██████╔╝██║     ███████║███████╗██║██║ ╚████║╚██████╔╝
 ╚═════╝ ╚═╝     ╚══════╝╚══════╝╚═╝╚═╝  ╚═══╝ ╚═════╝ 
</pre>

<i>— watching your stuff so you don't have to —</i>

### Tiny Telegram-first monitoring watchdog for indie hackers running a single VPS.

<img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License">
<img src="https://img.shields.io/badge/runs%20on-Docker-2496ED?logo=docker&logoColor=white" alt="Runs on Docker">
<img src="https://img.shields.io/badge/alerts-Telegram-26A5E4?logo=telegram&logoColor=white" alt="Alerts to Telegram">
<img src="https://img.shields.io/badge/node-22+-339933?logo=node.js&logoColor=white" alt="Node 22+">
<img src="https://img.shields.io/badge/built%20for-indie%20hackers-FF7A59" alt="Built for indie hackers">

<sub>
  <a href="#install">Install</a> ·
  <a href="#manage">Manage</a> ·
  <a href="#talk-to-it-on-telegram">Telegram commands</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="docs/project-overview.md">Overview</a> ·
  <a href="docs/tech.md">Tech</a> ·
  <a href="docs/future_plans.md">Roadmap</a>
</sub>

</div>

---

Opsling runs as a Docker container alongside your other services and watches the things you care about — system health, container lifecycle, container resource usage, container logs — and pings you on Telegram when something looks wrong. When it clears, you get a recovery message. **One alert per incident.** No dashboards. No extra infra.

Built for the "I have one Hetzner box with Coolify on it" crowd. Not a Prometheus replacement.

## What it watches

- 🖥️  **System health** — CPU, memory, disk, load.
- 📦  **Docker container lifecycle** — start, stop, restart, die, OOM-kill (real-time via Docker events).
- 📊  **Per-container resource usage** — CPU and memory against thresholds (configurable per-container).
- 📝  **Container logs** — streamed continuously, scanned for error patterns (configurable, with ignore-lists).

## Install

One line on your VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/go-native/opsling/main/scripts/install.sh | sh
```

The installer prompts you for your Telegram bot token and chat id (see [below](#getting-a-telegram-bot-token--chat-id) if you don't have them yet), pulls the image, installs an `opsling` helper command, and starts the container. You should get a Telegram message the moment something crosses a threshold.

**Install layout adapts to who runs it:**

| Run as | Files land in | Helper CLI |
|---|---|---|
| **root** (typical VPS install via `sudo` or root ssh) | `/opt/opsling/` | `/usr/local/bin/opsling` |
| **regular user** (Mac, Linux laptop) | `$HOME/.opsling/` | `$HOME/.local/bin/opsling` |

No sudo needed on a Mac. Same one-liner everywhere.

> **macOS note.** The installer detects Docker Desktop and uses a simplified compose without the host filesystem bind (`/:/host`). Docker Desktop's VM can't satisfy the Linux mount-propagation flag the bind needs, and the disk numbers it would report are the VM's, not your Mac's. As a result, disk-usage alerts on macOS reflect the container's view rather than the host's — fine for testing the install flow, not meaningful for real disk monitoring. For accurate Mac monitoring during development, run natively with `pnpm dev` instead.

### Non-interactive install (for scripts, CI, IaC)

Pass everything as CLI flags — works reliably through a pipe:

```bash
curl -fsSL https://raw.githubusercontent.com/go-native/opsling/main/scripts/install.sh \
  | sh -s -- \
      --bot-token "123:abcdef..." \
      --chat-id   "987654321" \
      --set CPU_THRESHOLD=90 \
      --set IGNORE_CONTAINERS=opsling,traefik \
      --set HOSTNAME_LABEL=hetzner-cx22
```

`--set KEY=VALUE` is repeatable and accepts **any** key from [`.env.example`](.env.example) — Telegram creds, thresholds, watch lists, intervals, alerting behavior, the lot.

Skip the prompts entirely and edit `.env` yourself afterwards:

```bash
curl -fsSL https://raw.githubusercontent.com/go-native/opsling/main/scripts/install.sh \
  | sh -s -- --skip-setup
opsling config        # edit .env in $EDITOR
opsling up
```

Installer flags:

| Flag                  | Effect                                                        |
|-----------------------|---------------------------------------------------------------|
| `--bot-token VALUE`   | Set `TELEGRAM_BOT_TOKEN` in `.env`                            |
| `--chat-id VALUE`     | Set `TELEGRAM_CHAT_ID` in `.env`                              |
| `--set KEY=VALUE`     | Set any env var in `.env` (repeatable)                        |
| `--skip-setup`        | Don't prompt for credentials                                  |
| `--start`             | Force start at the end                                        |
| `--skip-cli`          | Don't install the `opsling` helper command                    |

Installer env overrides: `OPSLING_DIR`, `OPSLING_VERSION`, `OPSLING_CLI_DIR`, `OPSLING_REPO`.

> **Note on env-var pre-seed.** A line like `VAR=xxx curl ... | sh` passes `VAR` to `curl`, not to `sh`. If you really want the env-var route, `export` the variables first, then pipe. The CLI flags above are the recommended path.

### Getting a Telegram bot token + chat id

1. Open Telegram, search for **@BotFather**, send `/newbot`, follow the prompts. BotFather replies with your **bot token**.
2. Send any message to your new bot.
3. Visit `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser. Find `"chat":{"id":...}` — that number is your **chat id**.

For group/channel alerts, add the bot to the group, send a message there, and use that chat id (it'll be negative).

## Manage

The `opsling` helper command:

```bash
opsling status         # is it running?
opsling logs -f        # tail logs
opsling restart
opsling update         # pull latest image + restart
opsling config         # edit .env in $EDITOR
opsling health         # show /health endpoint JSON
opsling uninstall      # stop, remove, delete the install dir
opsling help           # full command list
```

It auto-detects the install dir (`$HOME/.opsling` for non-root installs, `/opt/opsling` for root installs) and is a thin wrapper over `docker compose -f <dir>/docker-compose.yml ...` — nothing magical, just less typing.

### Changing settings on the fly

Three ways, pick whichever fits your workflow:

```bash
# 1. one value from the CLI (great over SSH)
opsling set CPU_THRESHOLD 90
opsling set TELEGRAM_BOT_TOKEN "$(cat ~/secrets/bot-token)"
opsling get DISK_THRESHOLD              # tokens come back redacted
opsling restart                         # apply

# 2. several values at once, in your editor
opsling config

# 3. direct edit
$EDITOR ~/.opsling/.env && opsling restart        # or /opt/opsling/.env for root installs
```

Config changes need `opsling restart` to take effect — `.env` is read at startup.

## Talk to it on Telegram

Send these to your bot (only the configured chat is allowed to interact):

- `/status` — system metrics + running containers + active incidents
- `/help` — list commands

`/status` reply looks like:

```
📊 Opsling status — hetzner-cx22

🖥️ System
🧠 CPU: 23%
🧮 Memory: 47%
⚖️ Load: 0.8/core
💾 Disk /: 64%

📦 Containers (3 running)
🟢 api
🟢 postgres
🟢 worker

✅ No active incidents.
```

## Configuration

All configuration lives in `<install-dir>/.env` (`~/.opsling/.env` for user installs, `/opt/opsling/.env` for root installs). The required values:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

Common knobs (everything else is optional — sensible defaults shipped):

```env
IGNORE_CONTAINERS=opsling       # comma-separated OR ["a","b"] JSON-array
                                # everything else is watched by default

CPU_THRESHOLD=85
MEMORY_THRESHOLD=85
DISK_THRESHOLD=90
LOAD_THRESHOLD=4.0

REQUIRE_CONSECUTIVE=2           # readings needed before firing
RENOTIFY_AFTER_MINUTES=30       # 0 = one alert per incident, ever
SEND_RECOVERY=true
DAILY_HEARTBEAT_AT=             # HH:MM, empty = disabled
```

Full reference: [`docs/tech.md`](docs/tech.md#7-configuration-reference) · Template: [`.env.example`](.env.example)

## Upgrade

```bash
opsling update     # docker compose pull && docker compose up -d
```

Pinning a specific version:

```bash
OPSLING_VERSION=v0.2.0 \
  curl -fsSL https://raw.githubusercontent.com/go-native/opsling/main/scripts/install.sh \
  | sh -s -- --skip-setup
```

## Manual install (without the script)

If you don't want to pipe a script into `sh`, paste this into a `docker-compose.yml` next to your `.env`:

```yaml
services:
  opsling:
    image: ghcr.io/go-native/opsling:latest
    container_name: opsling
    restart: unless-stopped
    env_file: .env
    environment:
      HOST_FS_ROOT: /host
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /:/host:ro,rslave        # for accurate host disk monitoring
    ports:
      - "127.0.0.1:4717:4717"   # /health endpoint
```

Then `docker compose up -d`. Both volumes are mounted **read-only**. The `/:/host` bind lets Opsling see the host's actual disks instead of the container's overlay filesystem — see [`docs/tech.md`](docs/tech.md#5-docker) for the why.

## Documentation

- [`docs/project-overview.md`](docs/project-overview.md) — what Opsling is, who it's for, alerting behavior, example messages.
- [`docs/tech.md`](docs/tech.md) — architecture, project layout, config reference, build & release, native-install (advanced).
- [`docs/future_plans.md`](docs/future_plans.md) — v2 ideas: AI/LLM-powered triage, remediation actions (opt-in, human-in-the-loop), anomaly detection, more notifiers, optional `opsling top` TUI.

## Development

```bash
git clone https://github.com/go-native/opsling.git
cd opsling
pnpm install
cp .env.example .env             # fill in TELEGRAM_*
pnpm dev                         # tsx watch
pnpm test                        # vitest
pnpm typecheck                   # tsc --noEmit
pnpm build                       # tsup → dist/index.js
```

Requirements: Node 22+, pnpm, and a reachable Docker daemon.

## Contributing

Contributions welcome. Quick orientation:

- **Project layout** — [`docs/tech.md`](docs/tech.md) is the layout contract. New collectors go in `src/collectors/`, new notifiers in `src/notifiers/`, both behind small interfaces.
- **Tests** — pure logic gets `vitest` unit tests; Docker-dependent tests live in `tests/integration/` and must skip cleanly when Docker isn't available.

## License

MIT — see [LICENSE](LICENSE).
