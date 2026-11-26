# Mech Destiny — Pi Next Hackathon 2026 (app #2)

**Working title:** "Mech Destiny" — a merge-parts battle game for Pi Pioneers.
Re-platform of the Agent X Robot loop (collect → fuse → duel with stakes →
seasons) onto Pi: Pi Auth replaces wallet-connect, Pi payments replace minting,
and a backend replaces the contract. **Pi is not EVM — there is no Solidity,
no contract, no mint here.** Full design: `DESIGN.md`.

- **Hackathon:** Pi Next 2026 — $200,000 USDT pool (Judges' Pick $50k + Community
  Engagement Awards $150k to up to 2 teams). Open theme, up to 3 apps per team.
  Daily Quest is app #1; this is app #2.
- **Deadline:** Tue Jan 5, 2027, 11:59 PM PST = Wed Jan 6, 2027, 07:59 UTC = **14:59 WIB**.
- **Path:** Mainnet Pi app via the Developer Web Console at developers.minepi.com.
- **Status:** Day-1 scaffold. It runs, the loop works end-to-end in guest mode,
  and the Pi auth/payment code paths are written — but nothing is registered, no
  Pi account step has been done for this app yet, and no real Pi has moved.
  The user does the Pi-side steps.

## What it is

| Piece | How it works here |
|---|---|
| Day-1 check-in | POST `/api/checkin` — first check-in grants a Base Machine + 1 random part. Later check-ins: +1 part, +50 pts (+10 per streak day, cap +70). Streak day 3 → Rare, day 7 → Epic, day 14 → Legendary. Miss a day → streak resets to 1. After day 14, drops are random again. |
| Parts | 5 types (Gear, Circuit, Battery, Magnet, Core), each with randomly rolled Power / Speed / Armor. Rarities Common → Rare → Epic → Legendary → Ethereal. |
| Merge | POST `/api/merge` — 2 identical parts → 1 part, one rarity up. +25 pts, x2 if the result is Epic+. Idempotent via `mergeId`. Ethereal cannot merge. |
| Battle | POST `/api/battle` — 2-step: `preview` shows the enemy first (no battle used), 1 `reroll` per match, `fight` resolves, `surrender` (−25 pts, keep parts) only after the reroll. 1 free battle per UTC day; outcome computed server-side from squad stats. **Loser loses 1 random part to the winner.** Win → +1 Blueprint Fragment (+2 on a 3-win streak). Scaffold rival is a bot; real PvP matching is a TODO. |
| Forge | POST `/api/forge` — 5 Blueprint Fragments + 1 Legendary part → 1 Ethereal with a rolled ability (Overdrive / Shield / Magnet). Max 3 Ethereals owned, max 3 equipped. |
| Pay draws | Standard 0.5 π, Ethereal Forge 1 π, 10-pack 9 π (guaranteed ≥1 Legendary). Minimum drop is always Rare. **Ethereal Fate** pity: 11th draw without an Ethereal → Legendary+ guaranteed; 30th → Ethereal guaranteed. Draws are granted **only** via `/api/payment-complete`. |
| Reward pool | 10% of every pay draw goes to the pool (`/api/pool`). Weekly top 3 in match ranking split 10% of the pool (1st 5%, 2nd 3%, 3rd 2%). Payout credits the winners' Pi ledger in the scaffold — real Pi transfers are a TODO. |
| Shop | `/api/shop` — list a duplicate part for Pi, buy listings via a Pi payment, make/accept part-for-part or part-for-Pi trade offers. All ownership changes server-side only. |
| Leaderboard | GET `/api/leaderboard` — match ranking by wins this week, tie-break Machine Power. |
| PiNet | The whole page is the public, browse-only surface. Outside Pi Browser, `window.Pi` is absent: the app shows a PiNet notice and Pi-gated actions ask you to open it in Pi Browser. A clearly-labelled guest preview lets anyone try the game without a Pi account. |
| Auth | Pi Authentication only (scopes `username`, `payments`, `wallet_address`). The frontend user object is presentation-only — `/api/me` verifies the access token via Platform API `GET /me` and only that verified `uid` is trusted. |

## Stack

Plain HTML/JS frontend (`public/`) + zero-dependency Node API routes (`api/`) that run
as Vercel serverless functions and, locally, under `server.js` (same handlers, same
behaviour). No build step, no framework, no database yet — the store is in-memory
(`api/_lib/store.js`), with optional JSON persistence in local dev only.

```
mech-destiny/
├── DESIGN.md          full agreed game design (numbers, odds, caps)
├── public/            index.html, app.js, styles.css, privacy.html, logo.svg
├── api/
│   ├── _lib/store.js  users, parts, battles, draws, forge, shop, pool (in-memory)
│   ├── _lib/pi.js     Platform API: /me verify, payment approve/complete (server-side only)
│   ├── _lib/http.js   JSON helpers
│   ├── status.js      GET  /api/status
│   ├── me.js          POST /api/me            (verify Pi access token)
│   ├── checkin.js     POST /api/checkin       (idempotent daily claim + part)
│   ├── inventory.js   GET  /api/inventory
│   ├── merge.js       POST /api/merge         (idempotent via mergeId)
│   ├── battle.js      POST /api/battle        (preview / reroll / fight / surrender, 1 free/day)
│   ├── forge.js       POST /api/forge         (5 fragments + 1 Legendary -> Ethereal)
│   ├── equip.js       POST /api/equip         (equip/unequip Ethereal core, max 3)
│   ├── draw.js        GET  /api/draw          (odds + Ethereal Fate counter; never grants)
│   ├── leaderboard.js GET  /api/leaderboard   (match ranking + pool)
│   ├── pool.js        GET/POST /api/pool      (pool total; POST payout = weekly payout)
│   ├── shop.js        GET/POST /api/shop      (listings + trade offers)
│   ├── payment-approve.js   POST /api/payment-approve
│   └── payment-complete.js  POST /api/payment-complete (grants draws / shop sale)
├── server.js          local dev server (serves public/ + /api/*)
├── vercel.json        Vercel config
├── .env.example       env vars (copy to .env for local dev)
└── README.md          this file
```

## Run locally

```bash
cd ~/workspace/pi-next/mech-destiny
cp .env.example .env        # defaults: PI_SANDBOX=true, no server key, no mock auth
npm run dev                 # or: node server.js
# open http://localhost:3000
```

Try it without any Pi account: **Try as guest** → **Check in today** (Base Machine +
1 part) → tick two identical parts → **Merge** → **Battle today** → **Forge** once
you have 5 fragments + a Legendary. Re-checking in the same UTC day returns
`alreadyClaimed: true` with no double points. `npm run check` runs `node --check`
over every JS file.

## Deploy to Vercel

```bash
npm i -g vercel            # once, if not installed
cd ~/workspace/pi-next/mech-destiny
vercel                     # follow the prompts; accept the detected settings
vercel --prod              # promote to production when ready
```

Then set environment variables in the Vercel dashboard (Project → Settings →
Environment Variables), **never in code**:

| Variable | Value |
|---|---|
| `PI_SANDBOX` | `true` until Sandbox testing passes end-to-end |
| `PI_SERVER_API_KEY` | Server API Key from the Developer Web Console (leave empty for mock/sandbox mode) |
| `DEV_ALLOW_MOCK_AUTH` | **Never set on Vercel.** Local dev only. |

The deployed URL is the domain you register in the Developer Web Console (next section).
It must not start with "pi" (Pi trademark rules) — use a neutral domain. Note: this is
a **separate app** from Daily Quest in the Console, with its own App ID, domain
verification, Server API Key, and App Wallet.

## Register the app (user does this — Pi sign-in required)

1. Open the **Developer Web Console** at developers.minepi.com → create a new app
   (Staging first): name **Mech Destiny** (working title), paste the Vercel URL,
   and verify URL ownership when prompted (serve the Console's `validation-key.txt`
   from `public/`, as was done for Daily Quest).
2. Copy the **Server API Key** into Vercel env as `PI_SERVER_API_KEY` and redeploy.
   Keep `PI_SANDBOX=true` for now.
3. Create this app's **App Wallet** in the Console (needed before Pi payments work —
   Daily Quest hit "App Wallet Misconfigured" until its wallet was created).
4. In Pi Browser, open the app and tap **Authorize Sandbox** (Pi app → settings) so
   Sandbox auth/payments work.
5. Register a **PiNet subdomain** in the Developer Portal so the public surface is
   shareable outside Pi Browser.

## Test the Sandbox handshake, step by step

Do these in Pi Browser, with `PI_SANDBOX=true` and the Server API Key set:

1. **SDK loads:** open the app — the banner should read "Pi Browser detected" and
   "Pi SDK ready in Sandbox mode". (If it reads "Browsing without Pi Browser", you
   are not in Pi Browser.)
2. **Auth:** tap **Sign in with Pi** → approve in Pi Browser → the profile box shows
   your Pi username and `verified`. Then check `/api/me` behaviour: with no Server
   API Key it returns `verified:false` with a clear note (fail-closed by design).
   Local shortcut before registration: set `DEV_ALLOW_MOCK_AUTH=true` in local `.env`
   only — `/api/me` then returns a mock verified user labelled as such.
3. **Check-in:** tap **Check in today** → Base Machine + 1 part, streak 1, +50 pts.
   Tap again → `alreadyClaimed`, no double points, no double part.
4. **Merge:** check in on a second day (or use a second part) and merge two identical
   parts → 1 part, one rarity up, +25 pts. Replay the same `mergeId` → rejected.
5. **Battle:** tap **Find opponent** → the enemy's power and stats are shown
   first, next to yours → **Fight** (a win/loss resolves server-side; a loss
   costs a part, a win takes one + a fragment), or **Reroll opponent** once
   for a new rival, or — after the reroll — **Surrender** (−25 pts, keep your
   parts). Surrender before the reroll is rejected. After fight/surrender,
   tap again → rejected (free battle used).
6. **Pay draw (Sandbox — moves no real Pi):** tap **Ethereal Forge (1 π)** →
   confirm → Pi Sandbox payment sheet → approve in the app → server approve →
   server complete → a Rare+ part, Ethereal Fate counter updates, pool +0.1 π.
   Cancel the payment → no part granted. Kill the app mid-payment and reopen →
   the `onIncompletePaymentFound` callback completes it via `/api/payment-complete`.
7. **Shop:** list a part, buy it from a second account — the part changes owner
   only after the payment completes.
8. **PiNet:** open the Vercel URL in a normal browser — full page readable, auth and
   payment buttons explain they need Pi Browser. No Pi call is attempted.

Only when all eight pass, consider `PI_SANDBOX=false` for Mainnet — and only with a
fresh explicit go-ahead, since that flips payments to real Pi.

## TODO before submission (deadline Jan 5, 2027, 11:59 PM PST)

- [ ] Register Mech Destiny as a separate app in the Developer Web Console (Staging);
      deploy to Vercel; verify the domain; set `PI_SERVER_API_KEY`; create the App Wallet.
- [ ] Sandbox handshake passes end-to-end (the 8 steps above).
- [ ] **Replace the in-memory store with a real database** (Vercel KV / Postgres / any
      hosted store). On Vercel, function instances are ephemeral — machines, parts and
      leaderboards will silently reset on cold starts until this is done. The swap is
      one module (`api/_lib/store.js`); the API surface is already DB-shaped.
- [ ] **Real PvP matching** for battles (currently a bot rival) — match by Machine
      Power bands, with a timeout so a battle always resolves.
- [ ] **Real Pi settlement:** weekly pool payouts to winners and shop seller payouts
      are currently backend-ledger credits only. Decide the payout flow (app wallet →
      winners/sellers) and implement it before Mainnet.
- [ ] Weekly payout job: `/api/pool` payout is currently a manual call — move it to a
      scheduled/admin-only job before submission.
- [ ] Anti-farming: per-uid rate limits, and decide whether guest-mode players appear
      on the leaderboard (currently they do, same as Daily Quest).
- [ ] Notification Center: streak reminders + battle-result notifications to bring
      players back (engagement prize).
- [ ] Privacy policy: finalise `public/privacy.html` — replace every `[BRACKETED]`
      item (developer name, contact email, hosting/database, retention periods).
- [ ] Logo: finalise a trademark-safe logo (current `logo.svg` is a plain gear —
      no Pi branding, no "pi" prefix). App name/domain must not start with "pi".
- [ ] Preview images: screenshots of the real app UI for the submission form.
- [ ] Demo video ≤3 min, public (YouTube), covering the 5 required beats in order:
      (1) what the app does, (2) feature/interface walkthrough, (3) who it's for,
      (4) the problem it solves, (5) how Pi is part of it (sign-in + payments).
- [ ] Submit in the Developer Web Console before the deadline; list team members.
      (Up to 3 apps per team — Daily Quest is app #1, Mech Destiny is app #2.)

## Safety notes

- The Server API Key must never appear in client-side code, logs, or the frontend
  bundle. It lives only in `api/_lib/pi.js` via env.
- Payments are Pi-only. No other token, no fiat, no external redirects, no email
  login — all four would fail Mainnet Listing Guidelines criterion 1.
- `DEV_ALLOW_MOCK_AUTH` is local-dev only and must never be set on Vercel.
- Nothing in this scaffold registers, signs in, or spends anything on its own.
  Every Pi action happens in Pi Browser, by the user, with a confirmation.
