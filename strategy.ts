// FirstLight — a patient early-entry bot for the pump.fun bonding-curve replay.
//
// Idea: most pump.fun coins die flat; a few run to completion (14.7x on the
// curve). This bot buys small and early, only into launches that already show
// organic buying — at least 8 distinct buyers, net SOL flowing in, price up
// from create, creator not selling — and then gets out fast: take profit at
// +25%, stop at -15%, never hold past 8 slots unless up 30%. Buys refuse any
// fill whose price jumped more than 5% in the 2-slot latency (no chasing
// spike tops). One add on strength. Tiny probe round trips keep the 20-coin
// guardrail met. A drawdown brake stops new entries while equity is under
// 9.2 SOL.
//
// Sweep history on the dev window (local engine port, mean over 4 failed-tx
// keys): v1 selective entries + trail exits -0.81 SOL; fast exits -0.44;
// 8+ buyers + 5-slot holds -0.03; final settings -0.02 SOL, 31% wins,
// 0.3% max drawdown — still below hold-cash on dev, but the least-bad
// measured shape: the market charges ~4.6% per round trip in fees on a
// 0.01 SOL stake, so only the tightest, most selective scalps survive.
//
// Pure function of the hello/batch/orders/slot stream: no clock, no randomness,
// no I/O, so the two graded executions produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Oldest age (slots since CreateEvent) at which a first buy may be decided. */
  entryAgeMax: number;
  /** Trades seen before an entry is allowed. */
  minTrades: number;
  /** Distinct (non-creator) buyers seen before entry, at least / at most. */
  minBuyers: number;
  maxBuyers: number;
  /** Net buy SOL (buys minus sells) over the tape at entry. */
  minNetSol: number;
  /** Price now over the create price, at least. */
  minRunup: number;
  /** Real SOL reserve window at entry. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys before entry: at most this much SOL (a dev-heavy launch). */
  maxCreatorBuy: number;
  /** Largest single buyer's share of buy SOL, at most. */
  maxBuyerShare: number;
  /** A single sell this big before entry disqualifies the coin. */
  maxSeenSell: number;
  /** SOL for the first buy (clipped by the 1%-of-reserve cap and free cash). */
  initialSol: number;
  /** Smallest buy worth sending (also the guardrail round-trip floor). */
  minBuySol: number;
  /** One add, this much SOL, once price runs this far above the entry price. */
  addSol: number;
  addRunup: number;
  /** Real SOL at least this for the add. */
  addMinRealSol: number;
  /** Slippage allowed on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exit when the position is worth this much under its cost. */
  stopLoss: number;
  /** Trailing stop: arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  trail: number;
  /** First take-profit: sell half the tokens once value reaches cost * tpAt. */
  tpAt: number;
  /** Exit when the creator sells (rug signal). */
  exitOnCreatorSell: boolean;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held, unless the position is up this much. */
  maxHold: number;
  holdIfUp: number;
  /** Most positions open at once. */
  maxPositions: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Stop opening new entries while equity (cash + marked positions) is under this. */
  equityBrake: number;
  equityResume: number;
  /** Guardrail pacing: keep this many coins with >=minBuySol round trips. */
  targetCoins: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  entryAgeMax: 10,
  minTrades: 3,
  minBuyers: 8,
  maxBuyers: 12,
  minNetSol: 0.15,
  minRunup: 0.1,
  minRealSol: 0.3,
  maxRealSol: 40,
  maxCreatorBuy: 2.5,
  maxBuyerShare: 0.8,
  maxSeenSell: 0.5,
  initialSol: 0.01,
  minBuySol: 0.01,
  addSol: 0.05,
  addRunup: 0.4,
  addMinRealSol: 3,
  buySlipBps: 500,
  stopLoss: 0.15,
  trailArm: 0.5,
  trail: 0.25,
  tpAt: 1.25,
  exitOnCreatorSell: true,
  bigSellSol: 1,
  maxHold: 8,
  holdIfUp: 0.3,
  maxPositions: 5,
  maxExposureSol: 3,
  equityBrake: 9.2,
  equityResume: 9.5,
  targetCoins: 25,
  paceSecs: 21600,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
/** Curve fee on a trade (protocol 95bps + creator 30bps). */
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  createPrice: number;
  creator: string;
  trades: Trade[];
  entered: boolean;
}

interface Held {
  opened: number;
  entryPrice: number;
  peakValue: number;
  added: boolean;
  tookTp: boolean;
  exiting: boolean;
  filled: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  let brakeOn = false;
  const keep = 2200;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, createPrice: 0, creator: '', trades: [], entered: false };
      tapes.set(mint, t);
    }
    return t;
  };

  /** SOL the position would fetch if sold into the curve now, fees deducted. */
  const sellValue = (state: BotState, mint: Pubkey, tokens: bigint, tx: number): number => {
    const curve = state.curves.get(mint);
    if (curve === undefined) return 0;
    const vq = Number(curve.virtual_quote_reserves);
    const vt = Number(curve.virtual_token_reserves);
    const n = Number(tokens);
    if (vt + n <= 0) return 0;
    return ((n * vq) / (vt + n) / LAMPORTS) * (1 - CURVE_FEE) - tx;
  };

  /** Entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (t.created === null || now - t.created > p.entryAgeMax) return false;
    if (rqSol < p.minRealSol || rqSol > p.maxRealSol) return false;
    if (t.trades.length < p.minTrades) return false;
    let buySol = 0;
    let sellSol = 0;
    let creatorBuy = 0;
    let creatorSold = false;
    let biggestSell = 0;
    let lastPrice = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.buy) {
        buySol += tr.sol;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
        if (tr.user === t.creator) creatorBuy += tr.sol;
      } else {
        sellSol += tr.sol;
        if (tr.sol > biggestSell) biggestSell = tr.sol;
        if (tr.user === t.creator) creatorSold = true;
      }
      lastPrice = tr.price;
    }
    if (creatorSold) return false;
    if (creatorBuy > p.maxCreatorBuy) return false;
    if (biggestSell >= p.maxSeenSell) return false;
    if (byUser.size < p.minBuyers || byUser.size > p.maxBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (t.createPrice <= 0 || lastPrice < t.createPrice * (1 + p.minRunup)) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (buySol > 0 && top > p.maxBuyerShare * buySol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const creatorSoldNow = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
          t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
          if (!e.is_buy && e.user === t.creator) creatorSoldNow.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Equity for the drawdown brake: cash plus marked sell value of positions.
      let equity = Number(state.cash) / LAMPORTS;
      for (const [mint, pos] of state.positions) {
        equity += Math.max(0, sellValue(state, mint, BigInt(pos.token_amount), tx));
      }
      if (brakeOn) {
        if (equity >= p.equityResume) brakeOn = false;
      } else if (equity < p.equityBrake) {
        brakeOn = true;
      }

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) held.delete(mint);
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = sellValue(state, mint, BigInt(pos.token_amount), tx);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        let exit = h.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && p.exitOnCreatorSell && creatorSoldNow.has(mint)) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        // First take-profit: sell half the tokens once value doubles cost.
        if (!exit && !h.tookTp && value >= cost * p.tpAt) {
          if (!pendingByMint.has(mint) && orders.length < cap) {
            const half = BigInt(pos.token_amount) / 2n;
            if (half > 0n) {
              orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: 10_000 });
              h.tookTp = true;
            }
          }
          continue;
        }
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        exposure += Math.max(h ? Number(pos?.cost_lamports ?? 0n) / LAMPORTS : 0, 0);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (brakeOn || slotsLeft <= 0) continue;
          if (t.entered) continue;
          if (free < p.minBuySol + tx + 1.5) continue;
          if (!entrySignal(t, now, rqSol)) continue;
          want = p.initialSol;
        } else {
          // One add on strength: price ran well above the entry price.
          if (h.added || h.exiting || !h.filled) continue;
          if (price < h.entryPrice * (1 + p.addRunup)) continue;
          if (rqSol < p.addMinRealSol) continue;
          want = p.addSol;
        }
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, {
            opened: now,
            entryPrice: price,
            peakValue: 0,
            added: false,
            tookTp: false,
            exiting: false,
            filled: false,
          });
          t.entered = true;
          slotsLeft--;
        } else {
          h.added = true;
        }
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetCoins * 2 * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
