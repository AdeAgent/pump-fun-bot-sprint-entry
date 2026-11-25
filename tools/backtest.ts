// FirstLight offline backtest: replays the kit dev window through the local
// engine port (kit tools/sim.ts) and prints net PnL, fills, coins, drawdown,
// win rate and the net without the best round trips.
//
//   node --experimental-strip-types tools/backtest.ts <kit dir> ['{param overrides}'] [--trips]
//
// The loader here reads ALL dataset parts (the kit's own backtest reads only
// part-00000); everything else follows the kit's loadDataset filtering.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import {
  loadDataset,
  makeHello,
  phaseSeed,
  simulate,
  type Dataset,
} from '/home/hatch/workspace/makefun/u-riidzhsn-pump-fun-bot-sprint-kit/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-kit/baselines/pilot/momentum/tools/sim.ts';

function loadAllParts(kit: string): Dataset {
  const base = loadDataset(kit);
  const manifest = JSON.parse(readFileSync(`${kit}/dataset/manifest.json`, 'utf8'));
  const { modulus, residue } = manifest.universe.sample;
  const excluded = new Set<string>(manifest.excluded_mints ?? []);
  const members = new Set<string>();
  const events: any[] = [];
  for (let i = 0; i < 3; i++) {
    const raw = gunzipSync(readFileSync(`${kit}/dataset/events/part-0000${i}.ndjson.gz`)).toString('utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const e = JSON.parse(line);
      if (e.event === 'CreateEvent' && !members.has(e.mint)) {
        const h = BigInt('0x' + createHash('sha256').update(e.mint, 'utf8').digest('hex'));
        if (
          e.quote_mint === '11111111111111111111111111111111' &&
          !e.is_mayhem_mode &&
          !e.is_cashback_enabled &&
          !excluded.has(e.mint) &&
          h % BigInt(modulus) === BigInt(residue)
        ) {
          members.add(e.mint);
        }
      }
      if (members.has(e.mint)) events.push(e);
    }
  }
  events.sort((a, b) => a.slot - b.slot);
  const batches: { slot: number; events: any[] }[] = [];
  for (const e of events) {
    const tail = batches[batches.length - 1];
    if (tail !== undefined && tail.slot === e.slot) tail.events.push(e);
    else batches.push({ slot: e.slot, events: [e] });
  }
  return { ...base, events, batches };
}

const kit = process.argv[2];
if (kit === undefined) {
  console.error('usage: node --experimental-strip-types tools/backtest.ts <kit dir> [params json] [--trips]');
  process.exit(2);
}
const overrides = process.argv[3] !== undefined && process.argv[3].startsWith('{') ? (JSON.parse(process.argv[3]) as Partial<Params>) : {};
const ds = loadAllParts(kit);
const hello = makeHello(phaseSeed('pilot-pumpfun-replay', 'dev', ds.sha256));
const params = { ...DEFAULT_PARAMS, ...overrides };
const sol = (x: bigint) => (Number(x) / 1e9).toFixed(4);
const r = simulate(ds, hello, createStrategy(params));
const trips = r.trips.map((t) => Number(t.pnl) / 1e9).sort((a, b) => b - a);
const wins = r.trips.filter((t) => t.pnl > 0n).length;
console.log(
  `net ${sol(r.netPnl)} SOL  fills ${r.fills}  coins ${r.mints}  trips ${r.trips.length}  wins ${wins} (${r.trips.length ? ((100 * wins) / r.trips.length).toFixed(0) : 0}%)  dd ${r.maxDrawdown.toFixed(4)}  rejected ${r.rejected} ${JSON.stringify(r.rejectReasons)}  failed ${r.failed}`,
);
console.log(
  `exBest ${(Number(r.netPnl) / 1e9 - (trips[0] ?? 0)).toFixed(4)}  exTop3 ${(Number(r.netPnl) / 1e9 - trips.slice(0, 3).reduce((a, b) => a + b, 0)).toFixed(4)}  best trips: ${trips.slice(0, 5).map((x) => x.toFixed(3)).join(', ')}  worst: ${trips.slice(-3).map((x) => x.toFixed(3)).join(', ')}`,
);
const noFail = simulate(ds, hello, createStrategy(params), { failKey: null });
console.log(`without failed txs ${sol(noFail.netPnl)} SOL`);
if (process.argv.includes('--trips')) {
  for (const t of r.trips) console.log(t.mint.slice(0, 8), t.open, t.close - t.open, sol(t.pnl));
}
