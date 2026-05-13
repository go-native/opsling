# Opsling — Future Plans

Forward-looking ideas for v2+. Nothing here is a commitment — it's a working backlog so v1 design choices stay compatible with where the project may go. See [`project-overview.md`](./project-overview.md) for what ships in v1 and [`tech.md`](./tech.md) for the v1 architecture.

> **North star:** Opsling should never become "another observability platform." It should stay a Telegram-first watchdog that an indie hacker can install in 5 minutes. v2 features earn their place by making that experience *more useful*, not by adding surface area.

---

## 1. AI / LLM-powered features

Opsling already collects exactly the kind of structured signal an LLM is good at digesting: time-ordered events, error log lines, resource metrics, and lifecycle transitions. The opportunity is to **summarize, correlate, and explain** — not to "do AIOps."

### 1.1 Log error clustering & summarization

Today a noisy container produces "47 ERROR lines in 60s". After v2:

> 🔴 **api** — 47 errors in last 60s
> Mostly **Postgres connection timeouts** (38 occurrences), with 6 mentioning `SSL handshake failed` and 3 transient `EAI_AGAIN` DNS errors.
> Earliest: 09:14:02 — Latest: 09:14:58
> [first 3 examples]

**Approach.** Group log lines by a cheap signature (regex strip of UUIDs / timestamps / paths), then have the LLM produce a one-paragraph summary of the cluster. Avoid sending the whole log buffer — sample representative lines per cluster.

**Architecture fit.** Slots in as an `enricher` stage between the log collector and the alert manager. No changes to existing collectors.

### 1.2 Root-cause hypothesis

When multiple signals fire close together, generate a hypothesis:

> 🔴 **Likely OOM kill on `worker`**
> Within 30s: memory hit 98% → container `worker` `die` (exit 137) → restart count 3 → `error allocating buffer` in logs.
> Suggested action: raise memory limit (`docker compose` → `mem_limit`) to ~512MB.

**Approach.** A small correlation window (~60s) collects related `NotificationEvent`s; if more than one fires for the same container, ask the LLM to produce a single combined message with a hypothesis. Original alerts are suppressed in favor of the combined one.

### 1.3 Conversational triage

Reply to a Telegram alert with `?`, `why?`, or any free-text question. Opsling fetches the last N minutes of relevant logs + stats and replies with a short LLM-generated diagnosis.

**Approach.** Telegram bot already receives messages via webhook or long-polling. Adding inbound handling is small. The reply uses incident context (already keyed by `container:metric`) to scope what's pulled.

### 1.4 Weekly digest

A scheduled summary, e.g. Sunday 9am:

> 📊 **Weekly digest — hetzner-cx22**
> 4 incidents this week, 2 critical. Longest: `api` CPU 11min on Wed.
> Top noisy container: `worker` (12 log error spikes, mostly DB timeouts).
> Near-misses: disk hit 86% twice (threshold 90%).
> Trend: memory baseline ↑ 8% week-over-week.

**Approach.** A small SQLite store (introduced in v1.5, see §3) holds incident history. LLM renders the digest from rolled-up stats.

### 1.5 Anomaly detection (baseline-aware thresholds)

Static thresholds miss slow leaks. v2 learns a 7-day rolling baseline per metric and alerts on **deviation**, not absolute level. CPU that's normally 20% suddenly sitting at 60% is interesting, even though it's nowhere near 85%.

**Approach.** No ML required for v2.0 — a simple rolling p95 + z-score is enough. LLMs are not in this loop; this is plain statistics, kept fast and explainable.

### 1.6 Suggested fixes for known patterns

When a known pattern fires, attach a fix suggestion:

- OOM kill → "Raise `mem_limit` for `<container>`. Current: 256MB. Peak observed: 248MB."
- Disk full → "Top 5 largest paths on `/`: …" (computed locally via `du`).
- Repeated restarts (`restart_count` climbing) → "Last 30 lines of `docker logs <container>`:".
- DB connection storms → "Check max_connections vs. observed concurrency."

**Approach.** Most of this is a static rules table; LLM is optional polish for the wording. Keep deterministic fallbacks so the feature still works offline.

### 1.7 LLM provider strategy

- **Pluggable.** `LLM_PROVIDER=openai|anthropic|ollama|none`. Defaults to `none` so v2 keeps offline parity with v1.
- **Bring your own key.** No hosted proxy. Users put their own API key in `.env`.
- **Local-first option.** Ollama support (e.g. small Llama / Qwen models) for users who want zero data egress.
- **Privacy.** Logs never leave the host unless the user opts in by setting a remote provider. Redaction pass strips tokens / emails / IPs before the LLM call when the user enables `LLM_REDACT=true`.

---

## 2. Remediation actions (controlled write access)

Today Opsling is **read-only**: it watches and reports. v2 explores letting it **act** — restart a container, stop a container, fetch recent logs — but only through **human-in-the-loop** Telegram commands with explicit confirmation. Never auto-remediation.

### Why human-in-the-loop only

Auto-restart loops can make incidents worse:

- A container that's "down" might be in the middle of a migration, log flush, or graceful shutdown.
- Auto-restart masks the underlying issue (OOM, config drift, dependency outage) rather than surfacing it.
- Two services restarting each other ping-pong style is a real failure mode in distributed systems.

The win is **shaving minutes off a fix you already know how to make** — you reply `/restart api` from your phone, see a confirmation, it happens — not deciding for the operator.

### Scope (proposed)

**Container actions — safe, container sandbox is enough:**

- `/restart <name>` — graceful restart with confirmation.
- `/stop <name>` — confirmation; extra "are you sure" if it's the only replica.
- `/start <name>` — only if the container exists and is stopped.
- `/logs <name>` — fetch last N lines inline (read-only, no actual write needed for this one).
- **Inline buttons attached to alerts**: "Restart" / "View logs" / "Snooze 1h". Lowest-friction UX.

**Host-level actions — deferred indefinitely:**

- Reboot, shutdown, kernel-level operations: technically possible from inside a container by mounting `/proc/sysrq-trigger`, the systemd D-Bus socket, or running with `--pid=host`, but every mechanism widens the attack surface considerably.
- Position: **not a v2 feature**. If you need to reboot the server, SSH in. Opsling stays inside the container sandbox.
- If a user really needs this someday, the cleanest path is a small **companion** service (e.g. `opsling-host-agent`) that runs natively under systemd and exposes a tiny local socket Opsling can write to. Two services, two security boundaries.

### Required changes

- `docker-compose.yml`: drop `:ro` from the `/var/run/docker.sock` mount (the only infra change).
- New module `src/actions/` parallel to `collectors/` and `notifiers/`, behind an `ActionExecutor` interface (matches the existing extension pattern).
- Extend `src/notifiers/telegram/commands.ts` to route action commands and render confirmation flows.
- **Mandatory audit log** (file + a separate Telegram channel if configured) of every action taken: who (chat id), when, what, exit status.
- `ENABLE_ACTIONS=false` by default. Explicit opt-in. A misconfigured Opsling must not become an unintended remote-control tool.
- Per-container allowlist: `ACTIONABLE_CONTAINERS=api,worker` so even with actions enabled, blast radius is bounded.

### Marketing guard

Keep the words "remediation" and "auto-heal" out of the description. Wrong promise. The honest pitch is "quick actions from your phone." That's the bar.

---

## 3. More notifiers

v1 is Telegram-only. v2 adds:

- **Slack** (incoming webhook + chat.postMessage).
- **Discord** (webhook).
- **Generic webhook** with templated JSON payload — covers PagerDuty / Opsgenie / custom routers.
- **Email** via SMTP for sites that already have a relay.
- **Severity routing**: e.g. critical → Telegram + Slack; warning → Slack only.

**Architecture fit.** The `Notifier` interface is already there in v1. Each new notifier is a self-contained module under `src/notifiers/`.

---

## 4. Light persistent state (SQLite)

v1 keeps everything in memory. v2 adds an **optional** SQLite store (via `better-sqlite3`) for:

- Incident history (for weekly digest + UI later).
- Baseline metric history (for anomaly detection).
- De-duped alert state across restarts — so a process restart doesn't replay an in-flight incident as a new one.

**Design constraints.** Opt-in via `STATE_DB_PATH`. If unset, behavior is identical to v1. The DB is bounded (e.g. 30 days, capped row count) and never exposed via a network port.

---

## 5. Multi-host (later, maybe never)

The current shape is **one Opsling per host**, on purpose. If multi-host ever becomes a real need:

- Each Opsling stays autonomous; no central server.
- Add an optional `HOSTNAME_GROUP` label so alerts from multiple hosts can be visually grouped in Telegram.
- A small "fleet view" digest (LLM-rendered) could roll up per-host summaries.

**Anti-goal.** No central control plane, no agent/server split. The day Opsling needs a backend, it stops being Opsling.

---

## 6. Per-container config in YAML (post-v1.x)

If users start needing per-container log patterns, ignore lists, severities, etc., we'll add an optional `opsling.yml`:

```yaml
containers:
  api:
    cpu_threshold: 95
    log_error_patterns: [ERROR, FATAL, "DB connection lost"]
    log_ignore_patterns: ["health check failed"]
    severity_overrides:
      restart: warning
```

`.env` stays the primary config; `opsling.yml` is optional and merged on top.

---

## 7. Optional local UIs (TUI and/or thin web UI)

Two paths, same underlying idea: give the operator a denser local view than scrolling `docker ps`/`docker stats`/`docker logs` separately. Both are **read-only** and both are optional — Telegram remains the primary interface.

### `opsling top` — interactive terminal UI (preferred path)

A separate command (likely powered by [pi-tui](https://github.com/earendil-works/pi-mono/tree/main/packages/tui) or similar) that connects to a small read-only HTTP API on the Opsling daemon and renders a live operator view:

- System gauges (CPU/Mem/Disk/Load).
- Container grid with state + per-container CPU/mem.
- Rolling log tail or recent incident timeline.
- Keybindings: `r` restart selected, `l` view logs, `s` snooze alert, `q` quit (action keys gate behind the v2 actions opt-in, see §2).

**Why a TUI over a web UI for this audience.** Indie hackers running a single VPS are usually already in an SSH session when they want this view. A TUI is one keystroke away, doesn't need a port forward, and looks at home next to `lazydocker` / `ctop` in their workflow.

**Architecture fit.** The TUI is a separate binary/package that talks to Opsling via the existing `:4717` HTTP service (extended with a small read-only endpoint set). The Docker container stays headless. Ships as part of (or alongside) the `opsling` helper CLI.

### Web UI variant

If users explicitly ask for a browser view:

- Bound to `127.0.0.1` only, no auth (power users tunnel via SSH).
- Same data as the TUI, read-only.

**Constraint for both.** No write actions in v2.x unless `ENABLE_ACTIONS=true` (see §2). No remote access by default. No separate auth layer to maintain.

---

## 8. Quality-of-life ideas (small but nice)

- **Quiet hours** — e.g. 23:00–07:00, only critical alerts fire; warnings queue for morning digest.
- **Snooze command** — reply `/snooze 1h api cpu` in Telegram to mute one alert key.
- **Maintenance mode** — `/maintenance start` / `/maintenance stop` suppresses all alerts for the host.
- **First-class systemd unit** for users who don't want the Docker-in-Docker pattern.
- **`opsling doctor` CLI** — run inside the container to verify Docker socket access, Telegram reachability, threshold sanity.

---

## 9. Things explicitly out of scope (so we don't drift)

- Long-term metrics storage / time-series DB.
- General-purpose log aggregation (we are not a Loki/Elastic replacement).
- Tracing, profiling, APM.
- Multi-tenant / SaaS hosted version.
- Container orchestration / auto-remediation.

If you find yourself wanting one of those, you've outgrown Opsling and that's fine.
