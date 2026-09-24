# LIVE signal rules and data-quality constraints

Signals are transparent research hypotheses. They support review and later analysis; they do not imply a validated betting recommendation.

## First 25-minute Dangerous Attacks

The card keeps the latest Socket update observed at or before minute 25. HOME and AWAY are considered independently. A side is highlighted when its observed DA is at least 20. A kickoff-minute baseline is not required and no later update is used to rewrite the checkpoint.

## Actual HT to 65-minute Dangerous Attacks

The baseline exists only when the active Collector session actually receives a provider `HALF_TIME` update containing valid DA values. A connection that begins during the second half does not invent a baseline from current or historical values.

For each side:

```text
current DA - actual HT DA >= 15
and current minute <= 65
```

At most one signal is persisted per fixture, rule version, and side. The displayed 65-minute state remains available after the evaluation deadline, but a new signal does not fire after minute 65.

## Continuous pressure hypothesis

Rolling Socket history tests whether Attack and Dangerous Attacks are rising across a real causal window. Current research thresholds are:

- 10-minute rapid pressure: Attack +15, DA +7, DA differential +6, and positive DA in both 5-minute halves.
- 15-minute sustained pressure: Attack +12, DA +10, DA differential +8, and positive DA across multiple 5-minute segments.

The live display can later classify a fired side as fading when the newest 5-minute DA increase is small. The first firing remains durable evidence; the active/faded UI state is deliberately volatile.

## Quality rules

- `NULL` is unknown, not zero.
- A decrease in a cumulative statistic is a provider correction/anomaly, not negative attacking activity.
- A raw message is retained even when its typed projection is skipped.
- Explicit terminal statuses end subscriptions. A transient `NOT_STARTED` or `match_live=0` frame after live play does not by itself terminate a fixture.
