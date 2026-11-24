// Launch sniper for the pump.fun replay (agent-fun/replay/v2).
//
// Idea: buy a coin in its first minute of life, but only when the launch looks honest:
// the creator bought a modest amount themselves, only a few other wallets piled in
// (a launch bundled by many wallets is a dump waiting to happen), the creator has not
// sold, and the price has not already run away. Take profit fast, cut losers faster,
// never hold long. A probe pacer backstops the minimum bar (a >= 0.01 SOL round trip
// on at least 20 coins) on quiet stretches.
//
// Deterministic: no clock, no randomness; iteration only over insertion-ordered maps
// fed by the batch stream. Amounts in SOL (floats) inside the strategy; the shim
// converts to lamports on the wire.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from "./vendor/makefun-bot.ts";

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125; // 1.25% curve fee on sells

interface Params {
  minAge: number; // youngest age (slots since create) to buy
  maxAge: number; // oldest age (slots) to buy
  stakeSol: number; // SOL per coin
  minBuySol: number; // smallest buy worth the tx fee
  minDevBuy: number; // creator's own buy in the opening tape, min
  maxDevBuy: number; // creator's own buy, max
  minBuyers: number; // distinct non-creator buyers before entry, min
  maxBuyers: number; // distinct non-creator buyers, max (bundle filter)
  skipDevSold: boolean; // skip if the creator sold before entry
  minRqSol: number; // real SOL at entry, min
  maxRqSol: number; // real SOL at entry, max
  minRunup: number; // price now over create price, min
  maxRunup: number; // price now over create price, max
  buySlipBps: number;
  takeProfit: number; // exit when value >= cost * (1 + takeProfit)
  stopLoss: number; // exit when value <= cost * (1 - stopLoss)
  trail: number; // trailing stop from peak value
  trailArm: number; // trailing arms once value >= cost * (1 + trailArm)
  maxHold: number; // slots held before time exit
  exitOnDevSell: boolean; // exit when the creator sells while held
  maxOpen: number; // positions open at once
  maxExposureSol: number; // total SOL at cost across positions
  targetCoins: number; // guardrail pace targets
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

const P: Params = {
  minAge: 0,
  maxAge: 60,
  stakeSol: 0.05,
  minBuySol: 0.01,
  minDevBuy: 0.05,
  maxDevBuy: 2.5,
  minBuyers: 0,
  maxBuyers: 2,
  skipDevSold: true,
  minRqSol: 0.5,
  maxRqSol: 5,
  minRunup: 0,
  maxRunup: 0.5,
  buySlipBps: 10000,
  takeProfit: 0.8,
  stopLoss: 0.15,
  trail: 0.2,
  trailArm: 0.2,
  maxHold: 600,
  exitOnDevSell: true,
  maxOpen: 8,
  maxExposureSol: 2,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 1,
};

interface Launch {
  created: number;
  creator: string;
  createPrice: number;
  devBuy: number;
  devSold: boolean;
  buyers: Set<string>;
  trades: number;
  seen: number; // last slot any trade was seen
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
}

export function createStrategy(p: Params = P): Bot {
  const launches = new Map<Pubkey, Launch>();
  const held = new Map<Pubkey, Held>();
  const bought = new Set<Pubkey>(); // coins already entered once
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const launchOf = (mint: Pubkey): Launch | undefined => launches.get(mint);

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const fresh = new Set<Pubkey>(); // curves with a trade this batch
      for (const f of batch.fills) {
        if (f.status === "filled" && !f.client_id.startsWith("_")) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === "CreateEvent") {
          launches.set(e.mint, {
            created: e.slot,
            creator: e.creator,
            createPrice: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
            devBuy: 0,
            devSold: false,
            buyers: new Set(),
            trades: 0,
            seen: e.slot,
          });
        } else if (e.event === "TradeEvent") {
          const l = launchOf(e.mint);
          if (l !== undefined) {
            l.trades++;
            l.seen = e.slot;
            const sol = Number(e.sol_amount) / LAMPORTS;
            if (e.user === l.creator) {
              if (e.is_buy) l.devBuy += sol;
              else l.devSold = true;
            } else if (e.is_buy) {
              l.buyers.add(e.user);
            }
          }
          fresh.add(e.mint);
        }
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // --- exits first ---
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) held.delete(mint);
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        let exit = h.exiting;
        const l = launchOf(mint);
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit && p.exitOnDevSell && l !== undefined && l.devSold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === "sell") sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
      }

      // --- probes: sell a landed probe right away ---
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
        if (!selling) probes.set(mint, true);
      }

      // --- snipe fresh launches that pass the rug filter ---
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of fresh) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        if (held.has(mint) || bought.has(mint) || probes.has(mint) || pendingByMint.has(mint)) continue;
        const l = launchOf(mint);
        const curve = state.curves.get(mint);
        if (l === undefined || curve === undefined || curve.complete) continue;
        const age = now - l.created;
        if (age < p.minAge || age > p.maxAge) continue;
        if (l.devBuy < p.minDevBuy || l.devBuy > p.maxDevBuy) continue;
        if (p.skipDevSold && l.devSold) continue;
        if (l.buyers.size < p.minBuyers || l.buyers.size > p.maxBuyers) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const runup = l.createPrice > 0 ? price / l.createPrice - 1 : 0;
        if (runup < p.minRunup || runup > p.maxRunup) continue;
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({
          side: "buy",
          mint,
          quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
          max_slippage_bps: p.buySlipBps,
        });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false });
        bought.add(mint);
        slotsLeft--;
      }

      // --- guardrail pacing: open a probe when fills or coins lag ---
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          for (const mint of fresh) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || bought.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < 0.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({
              side: "buy",
              mint,
              quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)),
              max_slippage_bps: p.buySlipBps,
            });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
