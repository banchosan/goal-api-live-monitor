# Architecture

## System boundary

The application is local-first. It uses provider APIs only when the operator explicitly runs the relevant collection workflow; the dashboard itself is not a hosted data service.

```text
GOAL REST / WebSocket
        |
        v
Collector + Bookmark Scheduler
        |
        +--> raw JSONL (immutable provider evidence)
        |
        +--> monitor_events (durable D1 receive log)
                       |
                       v
            GOAL normalizer + identity lookup
                       |
                       v
              live_snapshots (typed timeline)
                       |
          +------------+------------+
          |                         |
          v                         v
   live_signals                 local dashboard
   rule evidence                current state + history
          |
          v
read-only analysis dataset exporter
```

## Identity boundary

`core_fixtures` is the join boundary between PRE-MATCH and LIVE data. A provider fixture mapping is created only with provider fixture ID, kickoff, home/away provider team IDs, and league ID. Team and fixture names are display metadata, never automatic identity proof.

GOAL and API-Football fixtures remain separate unless the dedicated bridge finds sufficient safe evidence. This prevents an apparently convenient name match from contaminating later analysis.

## Persistence boundary

| Layer | Purpose |
| --- | --- |
| JSONL | Original provider message; supports future re-projection |
| `monitor_events` | Event lifecycle, socket observability, and traceability |
| `live_snapshots` | Typed features for causal checkpoints and offline datasets |
| `live_signals` | First trigger and rule evidence; not the whole population |

The raw layer is written before typed processing. A malformed field, unresolved identity, or typed-write failure does not erase the received provider event.

## Causal analysis boundary

Feature generation selects a snapshot only at or before a target minute. Actual half time uses an observed provider half-time marker, not a guessed minute-45 value. Future observations may be used only for explicitly named outcome labels.
