// FirstLight: a patient early-entry bot for the pump.fun Bot Sprint.
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and
// the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// The shim speaks the replay protocol for us: it reads each hello line once,
// then answers every batch line with exactly one reply carrying our orders
// for that slot, until the done line ends the run.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
