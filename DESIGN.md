# Mech Destiny — DESIGN.md

**Working title:** "Mech Destiny" — a merge-parts battle game for Pi Pioneers.
Pi Next Hackathon 2026, app #2 (Daily Quest is app #1). **Pi is not EVM — there
is no Solidity, no contract, no mint here.** Game state lives in the backend,
keyed by Pi uid. Agreed with the user 2026-11-26 (brainstormed slowly, built
only on "Ok build it").

## Core loop (30 seconds to understand)

1. **Day-1 check-in:** you get a **Base Machine + 1 random part**.
2. **Every day you check in:** +1 random part. Parts come in 5 types
   (Gear, Circuit, Battery, Magnet, Core) and 5 rarities.
3. **Merge 2 identical parts** (same type + same rarity) → 1 part, one rarity
   higher. The upgrade pop is the addictive hit.
4. **Battle** with your machine — absolute stakes, see below.
5. **Sell / trade duplicates** in the shop for Pi, buy the part you're missing,
   merge again.

## Parts

- **Types (5):** Gear, Circuit, Battery, Magnet, Core.
- **Stats:** every part has **Power / Speed / Armor, randomly rolled server-side
  on creation**. Higher rarity = higher stat ranges:

  | Rarity | Power | Speed | Armor |
  |---|---|---|---|
  | Common | 5–12 | 3–8 | 2–6 |
  | Rare | 10–20 | 6–14 | 4–10 |
  | Epic | 18–32 | 12–22 | 8–16 |
  | Legendary | 30–50 | 20–34 | 14–26 |
  | Ethereal | 45–75 | 30–50 | 22–40 |

- **Rarity tiers:** Common → Rare → Epic → Legendary → **Ethereal**
  (renamed from "Mystic" 2026-11-26; the pity system is **Ethereal Fate**).
- **Machine Power** = sum of the Power of all parts you own. The battle squad
  is your top 3 parts by Power; battle score = Power + 0.5×Speed + 0.5×Armor
  of the squad (rival computed the same way).

## Check-in & streak milestones

- One check-in per UTC day, idempotent (same day twice → `alreadyClaimed`).
- Points: **+50**, +10 per streak day, capped +70.
- **Day 3 streak → guaranteed Rare part. Day 7 → guaranteed Epic.
  Day 14 → guaranteed Legendary.**
- **Miss one day → streak resets to Day 1.**
- **After Day 14, drops go back to random** (Common 60%, Rare 28%, Epic 12%).
- Free daily drops **never** include Legendary or Ethereal.

## Merge

- 2 identical parts (same type + same rarity) → 1 part, one rarity up.
  Ethereal is max and cannot merge.
- Points: **+25 per merge, x2 if the result is Epic or higher**.
- Needs an idempotency key (`mergeId`) — replaying it is rejected.

## Battle — absolute, with stakes

Battle is 2 steps: **preview the enemy first, then choose.**

1. **Find opponent** (`POST /api/battle`, `action: 'preview'`): creates today's
   pending match and shows the enemy FIRST — name, Power / Speed / Armor,
   score, and top 3 parts — next to your own power/stats. Preview does NOT
   resolve the battle, does NOT consume the free battle, moves no part. A
   second preview the same day returns the SAME match (idempotent).
2. **Choose — 1 reroll per match** (`action: 'reroll'`): swaps the rival for
   a new random one; `rerollsLeft` becomes 0. A second reroll is rejected.
3. **Fight** (`action: 'fight'`, with the matchId): resolves exactly as the
   old immediate battle — stats vs stats, Power primary, Speed tie-break,
   Armor in the score; the client never decides it. Consumes the free battle.
4. **Surrender** (`action: 'surrender'`): available ONLY after the reroll has
   been used (`rerollsLeft: 0`). Costs **−25 points (floor 0, never below 0)**
   and NO part is lost or gained, no fragments. Consumes the free battle.

- **1 free battle per UTC day** against a rival. Scaffold: the server picks a
  bot rival (real PvP matching is a TODO).
- **Lose the battle → you lose a part** (1 random part, taken by the winner).
- **Win → you take 1 random part** from the loser (spoils part, Common/Rare/Epic)
  and earn **+1 Blueprint Fragment (+2 when your win streak hits 3, 6, 9…)**.
- Win streaks are tracked; **match ranking = wins this week**, tie-break by
  Machine Power.
- **Ethereal never drops from battle.**
- Ethereal ability **Shield**: if equipped and unused today, a lost battle
  keeps your part once per day instead of losing it.

## Ethereal — only 2 ways in

Ethereal parts never drop free and never drop from battle.

1. **Blueprint crafting (Forge):** **5 Blueprint Fragments + 1 Legendary part**
   of the chosen type → craft an **Ethereal** of that type. The Ethereal gets
   a randomly rolled ability (see below).
2. **Pay draws** (see below).

- **Ethereal abilities** (one rolled per Ethereal, shown on the part):
  - **Overdrive:** +20% Power in your next battle.
  - **Shield:** if you lose a battle, keep your part once per day.
  - **Magnet:** +1 Blueprint Fragment per win while equipped.
- **Up to 3 Ethereals equipped** as your machine's core at a time.
- **Max 3 Ethereals owned** at a time. A 4th (from a draw) is downgraded to
  Legendary; the Forge refuses to craft a 4th.

## Pay draws — Ethereal Fate (pity)

Minimum drop is **always Rare** — no Commons from paid draws.

| Draw | Price | Rare | Epic | Legendary | Ethereal |
|---|---|---|---|---|---|
| Standard Draw | 0.5 π | 70% | 22% | 7% | 1% |
| Ethereal Forge | 1 π | 55% | 30% | 12% | 3% |
| 10-pack | 9 π | 10× Forge rates, **guaranteed at least 1 Legendary** | | | |

- **Ethereal Fate (pity), visible in the UI:** after **10 draws without an
  Ethereal**, the next draw is **guaranteed Legendary or better**; after
  **30 draws without an Ethereal**, the next draw is **guaranteed Ethereal**.
  The counter resets when an Ethereal drops.
- Draws are granted **only** via the Pi payment complete callback
  (`/api/payment-complete`), never by a direct API call.

## Reward pool

- **10% of every pay draw's π goes into the reward pool** (server-side running
  total, visible at `/api/pool`).
- **Every week, the best 3 in match ranking split 10% of the total pool:**
  1st 5%, 2nd 3%, 3rd 2%. The pool never empties — it keeps growing.
- Weekly payout crediting to winners' Pi ledger is implemented in the store
  (`weeklyPayout()`); **real Pi transfers to winners are a TODO** — no real Pi
  moves in the scaffold.

## Shop

- **Sell duplicates:** list a part at a Pi price you set; other players buy it.
  The part changes owner server-side; the seller is credited in the backend
  Pi ledger (real Pi settlement to sellers is a TODO).
- **Trade offers:** part-for-part, or part-for-Pi (settled in the backend Pi
  ledger in the scaffold; real Pi settlement is a TODO).
- Listings are public. All ownership changes happen server-side only.

## Caps

- **Inventory cap: 50 parts total.** At the cap, check-in/draw part grants are
  blocked with a clear "inventory full — merge, sell or trade to make room"
  message (points and streak are still granted). Pay-draw approval is refused
  while the inventory cannot fit the draws.
- **Ethereal cap: 3 owned.**

## Economy summary (all numbers agreed 2026-11-26)

| Item | Value |
|---|---|
| Check-in points | +50, +10/streak day, cap +70 |
| Merge points | +25, x2 if result Epic+ |
| Free battle | 1 / UTC day |
| Win fragments | +1, +2 on 3-win-streak multiples |
| Forge craft | 5 fragments + 1 Legendary → 1 Ethereal |
| Pool share | 10% of every pay draw |
| Weekly pool payout | top 3 split 10% of pool (5/3/2%) |
| Inventory cap | 50 parts |
| Ethereal cap | 3 owned, 3 equipped |

## Tech

Same stack as Daily Quest: plain HTML/JS frontend (`public/`) + zero-dependency
Node API routes (`api/`) that run as Vercel serverless functions and, locally,
under `server.js`. Pi Auth only (scopes `username`, `payments`, `wallet_address`).
PiNet fallback + guest preview, same as Daily Quest. Store is in-memory with
optional local JSON persistence — **swap for a real DB before submission**
(Vercel function instances are ephemeral).
