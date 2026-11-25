// FirstLight parameter sweep on the kit dev window (local engine port).
//
//   node --experimental-strip-types tools/sweep.ts <kit dir> '<base json>' '<grid json>' [top N]
//
// Scores every combination as the mean net PnL over 4 failed-tx keys (the
// final window's draw is secret, so no setting is judged on one lucky draw),
// and prints the net without the best and best-two round trips, so a setting
// that only wins through one lucky coin stands out.

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

const [kit, baseJson, gridJson, topArg] = process.argv.slice(2);
if (kit === undefined || gridJson === undefined) {
  console.error("usage: node --experimental-strip-types tools/sweep.ts <kit dir> '<base json>' '<grid json>' [top]");
  process.exit(2);
}
const base = { ...DEFAULT_PARAMS, ...(JSON.parse(baseJson ?? '{}') as Partial<Params>) };
const grid = JSON.parse(gridJson) as Record<string, unknown[]>;
const ds = loadAllParts(kit);
const hello = makeHello(phaseSeed('pilot-pumpfun-replay', 'dev', ds.sha256));
const keys = Object.keys(grid);
const combos: Record<string, unknown>[] = [{}];
for (const k of keys) {
  const next: Record<string, unknown>[] = [];
  for (const c of combos) for (const v of grid[k]!) next.push({ ...c, [k]: v });
  combos.splice(0, combos.length, ...next);
}
const FAIL_KEYS = [11n, 22n, 33n, 44n];
interface Row {
  c: Record<string, unknown>;
  net: number;
  worst: number;
  exBest: number;
  ex2: number;
  fills: number;
  coins: number;
  dd: number;
  trips: number;
  wins: number;
}
const rows: Row[] = [];
for (const c of combos) {
  let sum = 0;
  let worst = Infinity;
  let exBest = 0;
  let ex2 = 0;
  let fills = Infinity;
  let coins = Infinity;
  let dd = 0;
  let trips = 0;
  let wins = 0;
  for (const failKey of FAIL_KEYS) {
    const r = simulate(ds, hello, createStrategy({ ...base, ...c } as Params), { failKey });
    const pnl = r.trips.map((t) => Number(t.pnl) / 1e9).sort((a, b) => b - a);
    const net = Number(r.netPnl) / 1e9;
    sum += net;
    worst = Math.min(worst, net);
    exBest += (net - (pnl[0] ?? 0)) / FAIL_KEYS.length;
    ex2 += (net - (pnl[0] ?? 0) - (pnl[1] ?? 0)) / FAIL_KEYS.length;
    fills = Math.min(fills, r.fills);
    coins = Math.min(coins, r.mints);
    dd = Math.max(dd, r.maxDrawdown);
    trips = r.trips.length;
    wins = r.trips.filter((t) => t.pnl > 0n).length;
  }
  rows.push({ c, net: sum / FAIL_KEYS.length, worst, exBest, ex2, fills, coins, dd, trips, wins });
}
rows.sort((a, b) => b.net - a.net);
for (const r of rows.slice(0, Number(topArg ?? 25))) {
  console.log(
    `mean ${r.net.toFixed(3)} worst ${r.worst.toFixed(3)} exBest ${r.exBest.toFixed(3)} ex2 ${r.ex2.toFixed(3)} fills ${r.fills} coins ${r.coins} trips ${r.trips} wins ${r.wins} dd ${r.dd.toFixed(3)} ${JSON.stringify(r.c)}`,
  );
}
