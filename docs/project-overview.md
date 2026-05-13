# Opsling — Project Overview

> Lightweight, single-binary-feel monitoring for indie hackers running their own VPS.
> One command to install. One Telegram chat for everything that matters. No dashboards, no clusters, no Prometheus to babysit.

---

## The problem

Indie hackers running a single VPS (Hetzner, Coolify-style stacks, a hand-rolled docker-compose, etc.) live in a gap:

- **Too small** for Prometheus + Grafana + Alertmanager. That stack costs more in ops time than the app itself.
- **Too important to fly blind**. If the API container dies at 2am, or disk fills up, or memory pegs at 100%, the user wants to know — now, on their phone — and get back to building.

Today the typical answer is "I'll SSH in if something feels off." Opsling replaces that with a tiny always-on watchdog that pokes you on Telegram the moment something breaks, and tells you when it's back.

## What Opsling is

A small Node.js / TypeScript service, distributed as a Docker image, that runs alongside your other containers on the same host and watches:

1. **System health** — CPU, memory, disk, load average against configurable thresholds.
2. **Docker container lifecycle** — start / stop / restart / die / OOM-kill events, in real time.
3. **Docker container logs** — streamed continuously, scanned for error patterns.

When a host threshold is crossed or an interesting Docker event fires, Opsling sends a nicely formatted Telegram message (with emojis, severity, container name where relevant, value, threshold). When the condition clears, it sends a recovery message with the incident duration.

Per-container CPU/memory thresholds are intentionally **not** a separate alert — container death and OOM events catch the "this container is broken" case more reliably, and host thresholds catch "the box is in trouble." Two signals, not three; no duplicate alerts when one container is eating the whole host.

That is the entire product.

## Target user

- Solo founder or small team running 1–N containers on a single VPS.
- Already familiar with Docker and SSH.
- Wants "did anything break?" answered without opening a dashboard.
- Will tolerate 5 minutes of setup, not 5 hours.

## Core features (v1)

### Monitoring
- **System metrics**: CPU %, memory %, disk % (per mount), load average. Configurable thresholds per metric.
- **Docker events**: subscribe to the Docker daemon event stream — get notified on `start`, `stop`, `die`, `restart`, `oom`, `kill`. Real-time, no polling.
- **Container log scanning**: tail logs of watched containers, match against configurable error regex patterns (defaults cover the common stuff: `ERROR`, `FATAL`, `panic`, stack traces, uncaught exceptions). Ignore patterns are also supported, so noisy false positives can be silenced.

### Alerting
- **Telegram bot** as the sole notifier in v1 — one bot token, one chat ID, defined in `.env`. The bot also responds to inbound commands (`/status`, `/help`) from the configured chat for on-demand status checks.
- **Severity-aware formatting**: 🔴 critical / 🟡 warning / 🔵 info, plus container name, metric, current value, threshold, and a timestamp.
- **State machine per check**: `OK → PENDING → FIRING → RECOVERED`. Requires N consecutive readings over threshold before firing — prevents flapping from transient spikes.
- **No spam by default**: one alert per incident. Re-notify after a configurable cooldown (default 30 min, set to `0` to disable).
- **Recovery messages**: when an incident clears, you get a ✅ message with the incident duration and peak value reached.
- **Daily heartbeat (optional)**: a single "I'm alive, N containers healthy, no incidents in last 24h" message at a configurable time, so silence ≠ Opsling crashed.
- **Self-monitoring**: if Opsling can't reach Docker or Telegram, it logs loudly and retries with backoff; once connectivity recovers, the queued alerts are flushed.

### Operations
- **Single Docker container** to deploy. Mounts `/var/run/docker.sock` to read host Docker state, and bind-mounts the host root at `/host` (read-only) so disk monitoring reflects the actual host disks, not the container's overlay.
- **One-line install** via `curl -fsSL https://opsling.dev/install.sh | sh` (URL is illustrative — owner decides domain).
- **All config via `.env`** — no YAML, no per-container annotations, no UI.
- **Nice startup banner** (`chalk`) with the wordmark `Opsling` and the version line beneath it.
- **Structured logs** (`pino`) at `info` / `warn` / `error`, pretty-printed in dev, JSON in prod.
- **Health endpoint** (`GET /health`) so you can stick Opsling itself behind an external uptime checker if you want belt-and-braces.

## How it works (high level)

```
                ┌──────────────────────────────────────┐
                │              Opsling                 │
                │                                      │
   docker.sock ─┼─▶  Docker collectors                 │
                │     • events stream (real-time)      │
                │     • stats poller (per container)   │
                │     • logs tail (per container)      │
                │                                      │
   /proc, /sys ─┼─▶  System collectors                 │
                │     • cpu / mem / disk / load        │
                │                                      │
                │            │                         │
                │            ▼                         │
                │      Alert manager                   │
                │      (state machine, hysteresis,     │
                │       cooldown, recovery)            │
                │            │                         │
                │            ▼                         │
                │      Notifier(s)                     │
                │      • Telegram                      │
                └────────────┼─────────────────────────┘
                             │
                             ▼
                       📱 Telegram chat
```

- **Collectors** push readings / events into the Alert manager.
- The **Alert manager** owns state per `(scope, metric)` key — e.g. `system:cpu`, `container:api:state:die`, `container:api:logs`.
- The **Notifier** is called only on `FIRING` transitions, scheduled re-notifies, or `RECOVERED` transitions.

### Check cadence

| Signal                       | Cadence            | Notes                                         |
|------------------------------|--------------------|-----------------------------------------------|
| Docker container events      | Real-time          | Event stream, no polling                      |
| Docker container logs        | Real-time          | Streaming tail per watched container          |
| System CPU / memory / load   | 30s (configurable) | `systeminformation`                           |
| Disk usage                   | 5m (configurable)  | Changes slowly                                |
| Self-health & heartbeat      | 1m / daily         | Internal                                      |

### Alerting behavior at a glance

- **Hysteresis**: `requireConsecutive = 2` by default → two over-threshold readings in a row before firing.
- **Cooldown**: while `FIRING`, suppress duplicate notifications for `reNotifyAfter = 30m` (re-send after that interval if still firing).
- **Recovery**: state must be below threshold for `requireConsecutive` readings before flipping to `RECOVERED`, then a recovery message is sent.
- **Per-incident keying**: `container:api:state:die` and `container:api:logs` are independent; one being noisy doesn't suppress the other.

## Example messages

```
🔴 CRITICAL — High CPU
host: hetzner-cx22
container: api
value: 96% (threshold 85%)
duration: 2m 30s
12 May 2026, 09:14 UTC
```

```
✅ Recovered — High CPU
container: api
peak: 99%
incident lasted 4m 12s
12 May 2026, 09:18 UTC
```

```
🟡 Container restarted
name: worker
exit code: 137 (likely OOM)
restart count: 3
12 May 2026, 09:20 UTC
```

```
🔴 Error in logs — api
"FATAL: connection to database lost (will retry)"
3 matches in last 60s
12 May 2026, 09:21 UTC
```

### Inbound commands

Send `/status` to the bot for an on-demand snapshot:

```
📊 Opsling status — hetzner-cx22

System
🔹 CPU: 23%
🔹 Memory: 47%
🔹 Load: 0.8/core
🔹 Disk /: 64%

Containers (3 running)
🟢 api
🟢 postgres
🟢 worker

✅ No active incidents.
12 May 2026, 09:14 UTC
```

Only messages from the configured `TELEGRAM_CHAT_ID` are honored — any other chat gets ignored and logged. Available commands: `/status`, `/help`.

## Installation overview

Two supported paths, both end with the same result: a single `opsling` container running on the host.

1. **One-line installer**
   ```
   curl -fsSL https://raw.githubusercontent.com/go-native/opsling/main/scripts/install.sh | sh
   ```
   - Verifies Docker is present.
   - Picks the install dir based on who's running it: `/opt/opsling/` for root, `$HOME/.opsling/` for non-root.
   - Drops a starter `.env` and `docker-compose.yml` into the install dir; prompts for `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` if not pre-seeded.
   - Installs an `opsling` helper command (in `/usr/local/bin/` or `$HOME/.local/bin/` to match the install dir).
   - Pulls the image and starts the container.
2. **Docker / docker-compose** — pull `ghcr.io/<owner>/opsling:latest`, mount `docker.sock`, mount `/:/host:ro,rslave`, mount `.env`, done.

Full details in `docs/tech.md`.

## Configuration overview

Everything lives in `.env`. A non-exhaustive flavor:

```
# Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

# What NOT to watch (everything else is watched by default)
IGNORE_CONTAINERS=opsling                   # default — never alert on yourself

# System thresholds (percent unless noted)
CPU_THRESHOLD=85
MEMORY_THRESHOLD=85
DISK_THRESHOLD=90
LOAD_THRESHOLD=4.0

# Log scanning
LOG_ERROR_PATTERNS=ERROR,FATAL,panic,Exception,Traceback
LOG_IGNORE_PATTERNS=
LOG_ALERT_MIN_OCCURRENCES=3      # avoid alerting on a single stray line
LOG_ALERT_WINDOW_SECONDS=60

# Cadence
SYSTEM_INTERVAL_SECONDS=30
DISK_INTERVAL_SECONDS=300

# Alerting behavior
REQUIRE_CONSECUTIVE=2
RENOTIFY_AFTER_MINUTES=30        # 0 = never re-notify
SEND_RECOVERY=true
DAILY_HEARTBEAT_AT=09:00         # leave empty to disable

# Misc
LOG_LEVEL=info
HOSTNAME_LABEL=hetzner-cx22      # shown in messages
HTTP_PORT=4717                   # /health endpoint
```

Full reference lives in `docs/tech.md` and `.env.example`.

## Non-goals (v1)

- **No web UI / dashboard.** Telegram is the interface.
- **No multi-host / agent topology.** Opsling watches the host it runs on. Run one per host.
- **No metric storage / time-series DB.** Opsling is stateless beyond a tiny in-process alert state. If you want history, pipe Telegram into your own archive.
- **No multi-channel notifier matrix.** Telegram only in v1. The notifier is interface-driven so Slack/Discord/email can land in v2 without rewrites.

## What's next

v1 keeps the scope tight (single host, Telegram-only, threshold-based). Bigger ideas — AI/LLM-powered triage, anomaly detection, more notifiers, multi-host — live in [`future_plans.md`](./future_plans.md), and the v1 architecture is built to stay compatible with them.

## License & distribution

- Open source, MIT (see `LICENSE`).
- Published as `ghcr.io/<owner>/opsling:<semver>` and `:latest`.
- Releases via GitHub Releases + Changesets-driven changelog (see `docs/tech.md`).
