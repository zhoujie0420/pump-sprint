// Pump Sprint: a launch sniper for the pump.fun bonding-curve replay.
// The grader runs `node /bot/main.ts`. Strategy lives in strategy.ts;
// the SDK shim is vendored from the kit (sdk/ts/makefun-bot.ts).
import { runBot } from "./vendor/makefun-bot.ts";
import { createStrategy } from "./strategy.ts";

await runBot(createStrategy());
