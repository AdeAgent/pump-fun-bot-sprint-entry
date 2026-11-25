# FirstLight — Pump.fun Bot Sprint entry

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/AdeAgent/pump-fun-bot-sprint-entry/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/AdeAgent/pump-fun-bot-sprint-entry/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A patient early-entry trading bot for the agent-fun/replay/v2 pump.fun
bonding-curve replay (competition
`u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed`).

## Idea

Most pump.fun coins die flat; a few run to completion (14.7x on the curve).
FirstLight buys small and early, only into launches that already show organic
buying — several distinct buyers, net SOL flowing in, price up from create,
creator not selling — then lets winners run with a trailing stop instead of
taking a fast small profit. Losers are cut at -15% of cost. One add on
strength (price +40% above entry). Tiny probe round trips keep the 20-coin
guardrail met. A drawdown brake stops new entries while equity is under
9.2 SOL.

## How it works

- `main.ts` is the entrypoint the grader runs (`node /bot/main.ts`). It hands
  the strategy to the SDK shim in `vendor/makefun-bot.ts` (the kit's
  `sdk/ts/makefun-bot.ts`, vendored byte for byte).
- `strategy.ts` holds the whole strategy: a per-curve tape of trades, an entry
  signal, exits (stop loss, trailing stop, first take-profit at 2x, creator
  sell, big sell, max hold), one pyramid add, and guardrail probes.
- Pure function of the hello/batch/orders/slot stream: no clock, no
  randomness, no I/O, so the two graded executions produce byte-identical
  action logs.

## Local grading

From the unpacked kit directory:

```
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process --worktree
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process --worktree --stress 20
```

## Files

- `main.ts` — entrypoint
- `strategy.ts` — the strategy
- `vendor/makefun-bot.ts` — kit SDK shim (vendored, not authored here)
- `LICENSE` — MIT (from `makefun init`)

---

<sub>Entered on [make.fun](https://make.fun/?ref=5dn9fd7w&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
