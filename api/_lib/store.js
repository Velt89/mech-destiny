'use strict';
/**
 * Mech Destiny — in-memory store (Day-1 scaffold).
 *
 * Keyed by Pi `uid` (app-local, from Pi.authenticate -> backend /me verification).
 * NEVER key by username: usernames can change; uid is the stable identity.
 *
 * Persistence: in-memory only unless DATA_FILE is set (local dev, server.js sets it
 * to ./data/store.json). On Vercel the store is per-function-instance and DOES NOT
 * survive cold starts — TODO before submission: swap this module for a real DB
 * (Vercel KV / Postgres / any hosted store). The API surface is intentionally
 * DB-shaped so the swap is one module, not a rewrite.
 *
 * Economy (agreed 2026-11-26, see DESIGN.md):
 *   - Check-in: +50 pts, +10 per streak day (cap +70), +1 part. Streak day 3 -> Rare,
 *     day 7 -> Epic, day 14 -> Legendary. Miss a day -> streak resets to 1.
 *     After day 14, drops are random again (Common 60 / Rare 28 / Epic 12).
 *   - Merge: 2 identical parts -> 1 part, one rarity up. +25 pts, x2 if result Epic+.
 *   - Battle: 1 free / UTC day. Preview the enemy first, 1 reroll per match,
 *     surrender (-25 pts, keep your parts) only after the reroll is used.
 *     Loser loses 1 random part to the winner.
 *     Win -> +1 Blueprint Fragment (+2 on win-streak multiples of 3).
 *   - Forge: 5 fragments + 1 Legendary -> 1 Ethereal (ability rolled).
 *   - Pay draws: min Rare always. Standard 0.5pi, Ethereal Forge 1pi,
 *     10-pack 9pi (guaranteed >=1 Legendary). Ethereal Fate pity: 11th draw
 *     without an Ethereal -> Legendary+ guaranteed; 30th -> Ethereal guaranteed.
 *   - Reward pool: 10% of every pay draw. Weekly top 3 split 10% of pool (5/3/2%).
 *   - Caps: 50 parts total; max 3 Ethereals owned, max 3 equipped.
 *
 * TODO (real Pi): weekly pool payouts and shop seller settlement are ledger
 * credits only in this scaffold — no real Pi is transferred to winners/sellers.
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.DATA_FILE || null;

// ---- constants ----
const PART_TYPES = ['Gear', 'Circuit', 'Battery', 'Magnet', 'Core'];
const RARITIES = ['Common', 'Rare', 'Epic', 'Legendary', 'Ethereal'];
const ABILITIES = ['Overdrive', 'Shield', 'Magnet'];
const INVENTORY_CAP = 50;
const ETHEREAL_CAP = 3;
const MAX_EQUIPPED_ETHEREAL = 3;
const FORGE_FRAGMENTS = 5;
const POOL_SHARE = 0.10; // 10% of every pay draw goes to the pool
const WEEKLY_PAYOUT_SHARE = [0.05, 0.03, 0.02]; // 1st 5%, 2nd 3%, 3rd 2% of pool
const SURRENDER_POINTS = 25; // surrender costs 25 points (floor 0), no part lost

const STAT_RANGES = {
  Common:    { power: [5, 12],  speed: [3, 8],   armor: [2, 6] },
  Rare:      { power: [10, 20], speed: [6, 14],  armor: [4, 10] },
  Epic:      { power: [18, 32], speed: [12, 22], armor: [8, 16] },
  Legendary: { power: [30, 50], speed: [20, 34], armor: [14, 26] },
  Ethereal:  { power: [45, 75], speed: [30, 50], armor: [22, 40] },
};

// Draw odds: [Rare, Epic, Legendary, Ethereal] (Commons never drop from paid draws).
const DRAW_ODDS = {
  standard: { price: 0.5, odds: [0.70, 0.22, 0.07, 0.01], draws: 1, minLegendary: 0 },
  forge:    { price: 1,   odds: [0.55, 0.30, 0.12, 0.03], draws: 1, minLegendary: 0 },
  pack10:   { price: 9,   odds: [0.55, 0.30, 0.12, 0.03], draws: 10, minLegendary: 1 },
};
const FREE_DROP_ODDS = [0.60, 0.28, 0.12]; // Common / Rare / Epic (free drops only)

// ---- UTC day / week helpers ----
function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}
function addDays(dayStr, n) {
  const d = new Date(dayStr + 'T00:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekKey(date = new Date()) {
  // ISO week key, e.g. "2026-W48".
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fday + 3);
  const week = 1 + Math.round((d - firstThursday) / (7 * 24 * 60 * 60 * 1000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ---- random helpers ----
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }
function pickWeighted(weights) {
  let r = Math.random();
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; }
  return weights.length - 1;
}
function randomType() { return PART_TYPES[Math.floor(Math.random() * PART_TYPES.length)]; }
let partSeq = 1;
function rollStats(rarity) {
  const r = STAT_RANGES[rarity];
  return { power: randInt(r.power[0], r.power[1]), speed: randInt(r.speed[0], r.speed[1]), armor: randInt(r.armor[0], r.armor[1]) };
}
function makePart(type, rarity) {
  const p = { id: `part-${Date.now().toString(36)}-${partSeq++}`, type, rarity, ...rollStats(rarity), equipped: false };
  if (rarity === 'Ethereal') p.ability = ABILITIES[Math.floor(Math.random() * ABILITIES.length)];
  return p;
}
function rarityIndex(r) { return RARITIES.indexOf(r); }

// ---- state ----
const users = new Map(); // uid -> user record
const usedMergeIds = new Set();
const usedBattleIds = new Set();
const payments = new Map(); // paymentId -> { paymentId, uid, amount, kind, drawType?, listingId?, status, txid }
const listings = new Map(); // listingId -> { id, sellerUid, partId, pricePi, status, createdAt }
const offers = new Map(); // offerId -> { id, fromUid, toUid, offeredPartId, wantedPartId, pricePi, status }
const matches = new Map(); // matchId -> { id, uid, rival, rerollsLeft, status, utcDay, createdAt }
let listingSeq = 1;
let offerSeq = 1;
let matchSeq = 1;
const pool = { totalPi: 0, paidOutPi: 0, lastWeeklyPayout: null };

function defaultUser(uid, username) {
  return {
    uid,
    username: username || 'Pioneer',
    points: 0,
    streak: 0,
    bestStreak: 0,
    totalCheckins: 0,
    lastClaimDay: null,
    hasMachine: false,
    parts: [],
    fragments: 0,
    wins: 0,
    losses: 0,
    winStreak: 0,
    bestWinStreak: 0,
    weeklyWins: 0,
    weeklyWinsWeek: weekKey(),
    lastBattleDay: null,
    shieldUsedDay: null,
    drawsWithoutEthereal: 0,
    totalDraws: 0,
    piBalance: 0, // backend Pi ledger (shop sales + weekly pool payouts; TODO: real settlement)
    createdAt: new Date().toISOString(),
  };
}

function getUser(uid, username) {
  if (!users.has(uid)) users.set(uid, defaultUser(uid, username));
  const u = users.get(uid);
  if (username && u.username !== username) u.username = username;
  return u;
}

function machinePower(u) {
  return u.parts.reduce((s, p) => s + p.power, 0);
}
function battleSquad(u) {
  return [...u.parts].sort((a, b) => b.power - a.power).slice(0, 3);
}
function squadScore(parts) {
  return parts.reduce((s, p) => s + p.power + 0.5 * p.speed + 0.5 * p.armor, 0);
}
function etherealCount(u) { return u.parts.filter((p) => p.rarity === 'Ethereal').length; }
function equippedEthereals(u) { return u.parts.filter((p) => p.rarity === 'Ethereal' && p.equipped); }
function hasAbility(u, ability) {
  return equippedEthereals(u).some((p) => p.ability === ability);
}
function resetWeeklyIfNeeded(u) {
  const wk = weekKey();
  if (u.weeklyWinsWeek !== wk) { u.weeklyWinsWeek = wk; u.weeklyWins = 0; }
}

function publicUser(u) {
  return {
    uid: u.uid,
    username: u.username,
    points: u.points,
    streak: u.streak,
    bestStreak: u.bestStreak,
    totalCheckins: u.totalCheckins,
    lastClaimDay: u.lastClaimDay,
    hasMachine: u.hasMachine,
    partsCount: u.parts.length,
    inventoryCap: INVENTORY_CAP,
    machinePower: machinePower(u),
    fragments: u.fragments,
    wins: u.wins,
    losses: u.losses,
    winStreak: u.winStreak,
    bestWinStreak: u.bestWinStreak,
    weeklyWins: u.weeklyWins,
    lastBattleDay: u.lastBattleDay,
    drawsWithoutEthereal: u.drawsWithoutEthereal,
    totalDraws: u.totalDraws,
    etherealFate: { drawsWithoutEthereal: u.drawsWithoutEthereal, nextLegendaryAt: 11, nextEtherealAt: 31 },
    etherealCount: etherealCount(u),
    etherealCap: ETHEREAL_CAP,
    equippedEthereal: equippedEthereals(u).length,
    piBalance: u.piBalance,
  };
}
function publicPart(p) {
  return { id: p.id, type: p.type, rarity: p.rarity, power: p.power, speed: p.speed, armor: p.armor, ability: p.ability || null, equipped: !!p.equipped };
}

/** Streak-milestone rarity for a check-in on the given streak day (null = random). */
function milestoneRarity(streak) {
  if (streak === 3) return 'Rare';
  if (streak === 7) return 'Epic';
  if (streak === 14) return 'Legendary';
  return null;
}
function freeDropRarity(streak) {
  const m = milestoneRarity(streak);
  if (m) return m;
  const i = pickWeighted(FREE_DROP_ODDS);
  return ['Common', 'Rare', 'Epic'][i];
}

/** Idempotent daily check-in. Same UTC day twice -> alreadyClaimed:true. */
function claimDaily(uid, username) {
  const u = getUser(uid, username);
  const today = utcDay();
  if (u.lastClaimDay === today) {
    return { alreadyClaimed: true, user: publicUser(u), today };
  }
  const yesterday = addDays(today, -1);
  u.streak = u.lastClaimDay === yesterday ? u.streak + 1 : 1;
  u.bestStreak = Math.max(u.bestStreak, u.streak);
  u.totalCheckins += 1;
  u.lastClaimDay = today;
  const bonus = 50 + Math.min((u.streak - 1) * 10, 70);
  u.points += bonus;
  let part = null;
  let inventoryFull = false;
  if (!u.hasMachine) u.hasMachine = true; // Base Machine granted on first check-in
  if (u.parts.length >= INVENTORY_CAP) {
    inventoryFull = true;
  } else {
    part = makePart(randomType(), freeDropRarity(u.streak));
    u.parts.push(part);
  }
  save();
  return { alreadyClaimed: false, bonus, part: part ? publicPart(part) : null, inventoryFull, user: publicUser(u), today };
}

/** Merge 2 identical parts -> 1 part, one rarity up. Idempotent via mergeId. */
function mergeParts(uid, username, { partIds, mergeId }) {
  const u = getUser(uid, username);
  if (!mergeId || typeof mergeId !== 'string') return { error: 'mergeId is required (idempotency key)' };
  if (usedMergeIds.has(mergeId)) return { error: 'merge already submitted', user: publicUser(u) };
  if (!Array.isArray(partIds) || partIds.length !== 2) return { error: 'exactly 2 part ids are required' };
  const [a, b] = partIds.map((id) => u.parts.find((p) => p.id === id));
  if (!a || !b) return { error: 'both parts must be in your inventory' };
  if (a.id === b.id) return { error: 'cannot merge a part with itself' };
  if (a.type !== b.type || a.rarity !== b.rarity) return { error: 'parts must be identical (same type and rarity)' };
  if (a.rarity === 'Ethereal') return { error: 'Ethereal is max — it cannot merge' };
  const resultRarity = RARITIES[rarityIndex(a.rarity) + 1];
  u.parts = u.parts.filter((p) => p.id !== a.id && p.id !== b.id);
  const result = makePart(a.type, resultRarity);
  u.parts.push(result);
  const points = resultRarity === 'Epic' || resultRarity === 'Legendary' || resultRarity === 'Ethereal' ? 50 : 25;
  u.points += points;
  usedMergeIds.add(mergeId);
  save();
  return { points, result: publicPart(result), user: publicUser(u) };
}

/** Equip / unequip an Ethereal as a machine core (max 3 equipped). */
function equipEthereal(uid, username, { partId, equip }) {
  const u = getUser(uid, username);
  const p = u.parts.find((x) => x.id === partId);
  if (!p) return { error: 'part not in your inventory' };
  if (p.rarity !== 'Ethereal') return { error: 'only Ethereal parts can be equipped as a core' };
  if (equip && !p.equipped && equippedEthereals(u).length >= MAX_EQUIPPED_ETHEREAL) {
    return { error: `max ${MAX_EQUIPPED_ETHEREAL} Ethereals equipped at a time` };
  }
  p.equipped = !!equip;
  save();
  return { part: publicPart(p), user: publicUser(u) };
}

/**
 * Bot rival generation for a preview: 3 parts, rarities scaled around the
 * player's top squad part (never Ethereal — Ethereal never drops from battle).
 * The rival is fixed once previewed; a reroll replaces it with a new one.
 */
function generateRival(u) {
  const squad = battleSquad(u);
  const topRarity = squad.length ? Math.max(...squad.map((p) => rarityIndex(p.rarity))) : 0;
  // Same number of parts as the player's squad (top 3), so a day-1 player
  // with 1 part does not face a 3-part rival — the old generator scaled the
  // rival score to 0.7x–1.3x of the player's, and this keeps that balance.
  const count = Math.max(1, Math.min(3, squad.length));
  const parts = Array.from({ length: count }, () => {
    const idx = Math.max(0, Math.min(RARITIES.length - 2, topRarity + (Math.floor(Math.random() * 3) - 1)));
    return makePart(randomType(), RARITIES[idx]);
  });
  return { name: `Rival-${Math.floor(Math.random() * 9000) + 1000}`, parts: parts.map(publicPart) };
}
function publicRival(r) {
  const parts = [...r.parts].sort((a, b) => b.power - a.power);
  return {
    name: r.name,
    power: parts.reduce((s, p) => s + p.power, 0),
    speed: parts.reduce((s, p) => s + p.speed, 0),
    armor: parts.reduce((s, p) => s + p.armor, 0),
    score: Math.round(squadScore(parts)),
    topParts: parts.map(publicPart),
  };
}
function myBattleStats(u) {
  const squad = battleSquad(u);
  let score = squadScore(squad);
  if (hasAbility(u, 'Overdrive')) score *= 1.2; // Overdrive: +20% Power next battle
  return {
    power: machinePower(u),
    speed: squad.reduce((s, p) => s + p.speed, 0),
    armor: squad.reduce((s, p) => s + p.armor, 0),
    score: Math.round(score),
  };
}
function previewPayload(match, u) {
  return {
    matchId: match.id,
    rival: publicRival(match.rival),
    myPower: myBattleStats(u).power,
    mySpeed: myBattleStats(u).speed,
    myArmor: myBattleStats(u).armor,
    myScore: myBattleStats(u).score,
    rerollsLeft: match.rerollsLeft,
    status: match.status,
    utcDay: match.utcDay,
  };
}

/**
 * Step 1 — preview the enemy. Creates today's pending match (idempotent:
 * a second preview the same day returns the SAME match). Does NOT resolve
 * the battle, does NOT consume the free battle, moves no part.
 */
function previewBattle(uid, username) {
  const u = getUser(uid, username);
  const today = utcDay();
  if (u.lastBattleDay === today) return { error: 'free battle already used today — come back tomorrow (UTC)' };
  if (u.parts.length === 0) return { error: 'you have no parts — check in to get your first part' };
  const existing = [...matches.values()].find((m) => m.uid === uid && m.utcDay === today && m.status === 'pending');
  if (existing) return previewPayload(existing, u);
  const match = {
    id: `match-${matchSeq++}`,
    uid,
    rival: generateRival(u),
    rerollsLeft: 1,
    status: 'pending',
    utcDay: today,
    createdAt: new Date().toISOString(),
  };
  matches.set(match.id, match);
  save();
  return previewPayload(match, u);
}

function getPendingMatch(uid, matchId) {
  const match = matches.get(matchId);
  if (!match) return { error: 'no pending match — find an opponent first' };
  if (match.uid !== uid) return { error: 'that match belongs to another player' };
  if (match.status !== 'pending') return { error: 'match already closed' };
  if (match.utcDay !== utcDay()) return { error: 'match expired — find a new opponent' };
  return { match };
}

/** Step 2a — reroll the opponent. Exactly 1 reroll per match. */
function rerollBattle(uid, username, { matchId }) {
  const u = getUser(uid, username);
  const found = getPendingMatch(uid, matchId);
  if (found.error) return { error: found.error, user: publicUser(u) };
  const { match } = found;
  if (match.rerollsLeft <= 0) return { error: 'no rerolls left — fight or surrender', user: publicUser(u) };
  match.rival = generateRival(u);
  match.rerollsLeft = 0;
  save();
  return previewPayload(match, u);
}

/** Step 2b — surrender. Only after the reroll is used. -25 pts (floor 0), no part lost or gained, no fragments. Consumes the free battle. */
function surrenderBattle(uid, username, { matchId }) {
  const u = getUser(uid, username);
  const found = getPendingMatch(uid, matchId);
  if (found.error) return { error: found.error, user: publicUser(u) };
  const { match } = found;
  if (match.rerollsLeft > 0) return { error: 'surrender unlocks after you use your reroll — reroll the opponent first', user: publicUser(u) };
  const pointsLost = Math.min(SURRENDER_POINTS, u.points);
  u.points -= pointsLost;
  u.lastBattleDay = utcDay();
  match.status = 'surrendered';
  save();
  return { surrendered: true, pointsLost, points: u.points, matchId: match.id, user: publicUser(u) };
}

/** Shared outcome resolution (no day/idempotency bookkeeping — callers do that). */
function resolveBattleOutcome(u, rivalParts, rivalName) {
  const squad = battleSquad(u);
  let myScore = squadScore(squad);
  if (hasAbility(u, 'Overdrive')) myScore *= 1.2; // Overdrive: +20% Power next battle
  const rivalScore = rivalParts ? squadScore(rivalParts) : myScore * (0.7 + Math.random() * 0.6);
  const won = myScore >= rivalScore;
  let partLost = null;
  let partWon = null;
  let shieldSaved = false;
  if (won) {
    u.wins += 1;
    u.winStreak += 1;
    u.bestWinStreak = Math.max(u.bestWinStreak, u.winStreak);
    u.weeklyWins += 1;
    const frags = u.winStreak % 3 === 0 ? 2 : 1;
    let bonus = frags;
    if (hasAbility(u, 'Magnet')) bonus += 1; // Magnet: +1 fragment per win while equipped
    u.fragments += bonus;
    if (u.parts.length < INVENTORY_CAP) {
      partWon = makePart(randomType(), ['Common', 'Rare', 'Epic'][pickWeighted(FREE_DROP_ODDS)]);
      u.parts.push(partWon);
    }
  } else {
    u.losses += 1;
    u.winStreak = 0;
    const today = utcDay();
    if (hasAbility(u, 'Shield') && u.shieldUsedDay !== today) {
      shieldSaved = true;
      u.shieldUsedDay = today;
    } else if (u.parts.length > 0) {
      const idx = Math.floor(Math.random() * u.parts.length);
      [partLost] = u.parts.splice(idx, 1);
    }
  }
  return {
    won, myScore: Math.round(myScore), rivalScore: Math.round(rivalScore), rivalName,
    partWon: partWon ? publicPart(partWon) : null,
    partLost: partLost ? publicPart(partLost) : null,
    shieldSaved,
    fragments: u.fragments,
  };
}

/**
 * Free daily battle (legacy single-call). Server-side outcome from squad stats.
 * Winner takes 1 random part from the loser. Win -> +1 fragment (+2 on
 * win-streak multiples of 3). Scaffold rival is a bot (real PvP matching TODO).
 */
function doBattle(uid, username, { battleId, rival } = {}) {
  const u = getUser(uid, username);
  if (!battleId || typeof battleId !== 'string') return { error: 'battleId is required (idempotency key)' };
  if (usedBattleIds.has(battleId)) return { error: 'battle already submitted', user: publicUser(u) };
  const today = utcDay();
  if (u.lastBattleDay === today) return { error: 'free battle already used today — come back tomorrow (UTC)' };
  if (u.parts.length === 0) return { error: 'you have no parts — check in to get your first part' };
  resetWeeklyIfNeeded(u);
  const rivalParts = (rival && rival.parts) || null;
  const rivalName = (rival && rival.name) || `Rival-${Math.floor(Math.random() * 9000) + 1000}`;
  const result = resolveBattleOutcome(u, rivalParts, rivalName);
  u.lastBattleDay = today;
  usedBattleIds.add(battleId);
  save();
  return { ...result, user: publicUser(u) };
}

/** Step 2c — fight a previewed match. Resolves exactly like doBattle, closes the match, consumes the free battle. */
function fightBattle(uid, username, { matchId, battleId }) {
  const u = getUser(uid, username);
  const found = getPendingMatch(uid, matchId);
  if (found.error) return { error: found.error, user: publicUser(u) };
  const { match } = found;
  if (battleId) {
    if (typeof battleId !== 'string') return { error: 'battleId must be a string' };
    if (usedBattleIds.has(battleId)) return { error: 'battle already submitted', user: publicUser(u) };
  }
  if (u.parts.length === 0) return { error: 'you have no parts — check in to get your first part' };
  resetWeeklyIfNeeded(u);
  const result = resolveBattleOutcome(u, match.rival.parts, match.rival.name);
  u.lastBattleDay = utcDay();
  if (battleId) usedBattleIds.add(battleId);
  match.status = 'resolved';
  save();
  return { ...result, matchId: match.id, user: publicUser(u) };
}

/** Forge: 5 fragments + 1 Legendary part -> 1 Ethereal of that type. */
function forgeCraft(uid, username, { legendaryPartId }) {
  const u = getUser(uid, username);
  if (etherealCount(u) >= ETHEREAL_CAP) return { error: `max ${ETHEREAL_CAP} Ethereals owned — sell or trade one first` };
  if (u.fragments < FORGE_FRAGMENTS) return { error: `need ${FORGE_FRAGMENTS} Blueprint Fragments (you have ${u.fragments})` };
  const leg = u.parts.find((p) => p.id === legendaryPartId);
  if (!leg) return { error: 'Legendary part not in your inventory' };
  if (leg.rarity !== 'Legendary') return { error: 'Forge needs a Legendary part (merges build it up)' };
  u.parts = u.parts.filter((p) => p.id !== leg.id);
  u.fragments -= FORGE_FRAGMENTS;
  const ethereal = makePart(leg.type, 'Ethereal');
  u.parts.push(ethereal);
  u.drawsWithoutEthereal = 0; // a crafted Ethereal resets Ethereal Fate too (you got one)
  save();
  return { result: publicPart(ethereal), fragments: u.fragments, user: publicUser(u) };
}

// ---- draws (granted ONLY via payment-complete) ----
function rollDrawRarity(u, drawType) {
  // Ethereal Fate pity: 30 draws without one -> guaranteed Ethereal;
  // 10 draws without one -> guaranteed Legendary or better.
  if (u.drawsWithoutEthereal >= 30) return 'Ethereal';
  if (u.drawsWithoutEthereal >= 10) {
    return Math.random() < 0.15 ? 'Ethereal' : 'Legendary';
  }
  const odds = DRAW_ODDS[drawType].odds; // [Rare, Epic, Legendary, Ethereal]
  const i = pickWeighted(odds);
  return ['Rare', 'Epic', 'Legendary', 'Ethereal'][i];
}

/** Grant N draws of a type. Caller must have checked inventory room first. */
function grantDraws(uid, username, drawType) {
  const u = getUser(uid, username);
  const cfg = DRAW_ODDS[drawType];
  if (!cfg) return { error: `unknown draw type: ${drawType}` };
  const granted = [];
  let legendaryCount = 0;
  for (let i = 0; i < cfg.draws; i++) {
    let rarity = rollDrawRarity(u, drawType);
    // Ethereal cap: a 4th Ethereal is downgraded to Legendary.
    let downgraded = false;
    if (rarity === 'Ethereal' && etherealCount(u) >= ETHEREAL_CAP) { rarity = 'Legendary'; downgraded = true; }
    if (rarity === 'Ethereal') u.drawsWithoutEthereal = 0; else u.drawsWithoutEthereal += 1;
    if (rarity === 'Legendary' || rarity === 'Ethereal') legendaryCount += 1;
    const part = makePart(randomType(), rarity);
    u.parts.push(part);
    granted.push({ ...publicPart(part), downgradedFromEthereal: downgraded });
    u.totalDraws += 1;
  }
  // 10-pack guarantee: at least 1 Legendary.
  if (cfg.minLegendary > 0 && legendaryCount < cfg.minLegendary) {
    const last = granted[granted.length - 1];
    const idx = u.parts.findIndex((p) => p.id === last.id);
    const upgraded = makePart(last.type, 'Legendary');
    u.parts[idx] = upgraded;
    granted[granted.length - 1] = { ...publicPart(upgraded), upgradedToLegendary: true };
    legendaryCount += 1;
  }
  save();
  return { granted, drawsWithoutEthereal: u.drawsWithoutEthereal, user: publicUser(u) };
}

function addToPool(amountPi) {
  pool.totalPi += amountPi * POOL_SHARE;
  save();
  return pool.totalPi;
}
function getPool() { return { totalPi: pool.totalPi, paidOutPi: pool.paidOutPi, lastWeeklyPayout: pool.lastWeeklyPayout }; }

/**
 * Weekly pool payout (scaffold: credits winners' Pi ledger; real Pi transfer TODO).
 * Top 3 by match ranking (weekly wins, tie-break Machine Power) split 10% of
 * the pool: 1st 5%, 2nd 3%, 3rd 2%. The pool never empties.
 */
function weeklyPayout() {
  const ranking = matchRanking(20);
  const payoutPool = pool.totalPi * 0.10;
  const winners = ranking.slice(0, 3).map((r, i) => {
    const share = payoutPool * (WEEKLY_PAYOUT_SHARE[i] / 0.10);
    const winner = getUser(r.uid);
    winner.piBalance += share;
    return { rank: i + 1, uid: r.uid, username: r.username, weeklyWins: r.weeklyWins, sharePi: share };
  });
  const paid = winners.reduce((s, w) => s + w.sharePi, 0);
  pool.paidOutPi += paid;
  pool.lastWeeklyPayout = { week: weekKey(), winners, paidPi: paid, at: new Date().toISOString() };
  save();
  return pool.lastWeeklyPayout;
}

function matchRanking(limit = 20) {
  [...users.values()].forEach(resetWeeklyIfNeeded);
  return [...users.values()]
    .sort((a, b) => b.weeklyWins - a.weeklyWins || machinePower(b) - machinePower(a))
    .slice(0, Math.max(1, Math.min(100, limit)))
    .map((u, i) => ({
      rank: i + 1, uid: u.uid, username: u.username, weeklyWins: u.weeklyWins,
      wins: u.wins, losses: u.losses, winStreak: u.winStreak, machinePower: machinePower(u), points: u.points,
    }));
}
function leaderboard(limit = 20) {
  return { matchRanking: matchRanking(limit), pool: getPool(), utcDay: utcDay() };
}

// ---- payments ----
function recordPayment(paymentId, uid, amount, extra = {}) {
  if (!payments.has(paymentId)) {
    payments.set(paymentId, { paymentId, uid, amount, status: 'created', txid: null, ...extra });
  }
  return payments.get(paymentId);
}
function setPaymentStatus(paymentId, status, txid) {
  const p = payments.get(paymentId);
  if (p) { p.status = status; if (txid) p.txid = txid; }
  return p;
}
function getPayment(paymentId) { return payments.get(paymentId) || null; }

// ---- shop ----
function createListing(uid, username, { partId, pricePi }) {
  const u = getUser(uid, username);
  const price = Number(pricePi);
  if (!Number.isFinite(price) || price <= 0) return { error: 'pricePi must be a positive number' };
  const part = u.parts.find((p) => p.id === partId);
  if (!part) return { error: 'part not in your inventory' };
  if ([...listings.values()].some((l) => l.partId === partId && l.status === 'active')) {
    return { error: 'that part is already listed' };
  }
  const listing = { id: `listing-${listingSeq++}`, sellerUid: uid, sellerUsername: u.username, partId, pricePi: price, status: 'active', createdAt: new Date().toISOString() };
  listings.set(listing.id, listing);
  save();
  return { listing: publicListing(listing), user: publicUser(u) };
}
function publicListing(l) {
  const seller = users.get(l.sellerUid);
  const part = seller ? seller.parts.find((p) => p.id === l.partId) : null;
  return { id: l.id, sellerUid: l.sellerUid, sellerUsername: l.sellerUsername, pricePi: l.pricePi, status: l.status, part: part ? publicPart(part) : null };
}
function listListings() {
  return [...listings.values()].filter((l) => l.status === 'active').map(publicListing);
}
function getListing(id) { return listings.get(id) || null; }

/** Transfer a sold listing's part to the buyer; credit the seller's Pi ledger. */
function completeShopSale(listingId, buyerUid, buyerUsername) {
  const l = listings.get(listingId);
  if (!l) return { error: 'listing not found' };
  if (l.status !== 'active') return { error: 'listing is no longer available' };
  if (l.sellerUid === buyerUid) return { error: 'you cannot buy your own listing' };
  const seller = getUser(l.sellerUid);
  const buyer = getUser(buyerUid, buyerUsername);
  if (buyer.parts.length >= INVENTORY_CAP) return { error: 'inventory full — merge, sell or trade to make room' };
  const idx = seller.parts.findIndex((p) => p.id === l.partId);
  if (idx < 0) return { error: 'listed part is gone' };
  const [part] = seller.parts.splice(idx, 1);
  part.equipped = false;
  buyer.parts.push(part);
  seller.piBalance += l.pricePi; // TODO: real Pi settlement to the seller
  l.status = 'sold';
  l.buyerUid = buyerUid;
  save();
  return { part: publicPart(part), pricePi: l.pricePi, sellerUid: l.sellerUid, user: publicUser(buyer) };
}

function createOffer(uid, username, { toUid, offeredPartId, wantedPartId, pricePi }) {
  const u = getUser(uid, username);
  const offered = u.parts.find((p) => p.id === offeredPartId);
  if (!offered) return { error: 'offered part not in your inventory' };
  if (!toUid || typeof toUid !== 'string' || toUid === uid) return { error: 'a valid other player uid is required' };
  const target = users.get(toUid);
  if (!target) return { error: 'target player not found — they must have played at least once' };
  let wanted = null;
  if (wantedPartId) {
    wanted = target.parts.find((p) => p.id === wantedPartId);
    if (!wanted) return { error: 'wanted part not in the target player inventory' };
  }
  const price = pricePi == null ? null : Number(pricePi);
  if (pricePi != null && (!Number.isFinite(price) || price <= 0)) return { error: 'pricePi must be a positive number' };
  if (!wanted && price == null) return { error: 'offer must ask for a part or a Pi price' };
  const offer = { id: `offer-${offerSeq++}`, fromUid: uid, fromUsername: u.username, toUid, offeredPartId, wantedPartId: wantedPartId || null, pricePi: price, status: 'open', createdAt: new Date().toISOString() };
  offers.set(offer.id, offer);
  save();
  return { offer: publicOffer(offer) };
}
function publicOffer(o) {
  const from = users.get(o.fromUid);
  const to = users.get(o.toUid);
  const offered = from ? from.parts.find((p) => p.id === o.offeredPartId) : null;
  const wanted = o.wantedPartId && to ? to.parts.find((p) => p.id === o.wantedPartId) : null;
  return { id: o.id, fromUid: o.fromUid, fromUsername: o.fromUsername, toUid: o.toUid, offeredPart: offered ? publicPart(offered) : null, wantedPart: wanted ? publicPart(wanted) : null, pricePi: o.pricePi, status: o.status };
}
function listOffersFor(uid) {
  return [...offers.values()].filter((o) => o.toUid === uid && o.status === 'open').map(publicOffer);
}
/** Accept an offer: swap parts, or take the part and pay the Pi price (ledger, TODO real Pi). */
function acceptOffer(uid, username, { offerId }) {
  const o = offers.get(offerId);
  if (!o) return { error: 'offer not found' };
  if (o.status !== 'open') return { error: 'offer is no longer open' };
  if (o.toUid !== uid) return { error: 'only the player the offer was made to can accept it' };
  const from = getUser(o.fromUid);
  const to = getUser(uid, username);
  const offeredIdx = from.parts.findIndex((p) => p.id === o.offeredPartId);
  if (offeredIdx < 0) return { error: 'offered part is gone' };
  if (o.wantedPartId) {
    const wantedIdx = to.parts.findIndex((p) => p.id === o.wantedPartId);
    if (wantedIdx < 0) return { error: 'wanted part is no longer in your inventory' };
    const [offeredPart] = from.parts.splice(offeredIdx, 1);
    const [wantedPart] = to.parts.splice(wantedIdx, 1);
    offeredPart.equipped = false; wantedPart.equipped = false;
    from.parts.push(wantedPart);
    to.parts.push(offeredPart);
  } else {
    if (to.piBalance < o.pricePi) return { error: `need ${o.pricePi} π in your Pi ledger (you have ${to.piBalance}) — earn it from shop sales or weekly pool payouts` };
    const [offeredPart] = from.parts.splice(offeredIdx, 1);
    if (to.parts.length >= INVENTORY_CAP) { from.parts.splice(offeredIdx, 0, offeredPart); return { error: 'inventory full — merge, sell or trade to make room' }; }
    offeredPart.equipped = false;
    to.parts.push(offeredPart);
    to.piBalance -= o.pricePi;
    from.piBalance += o.pricePi; // TODO: real Pi settlement
  }
  o.status = 'accepted';
  save();
  return { offer: publicOffer(o), user: publicUser(to) };
}

// ---- optional JSON persistence (local dev only) ----
function save() {
  if (!DATA_FILE) return;
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      users: [...users.values()],
      usedMergeIds: [...usedMergeIds],
      usedBattleIds: [...usedBattleIds],
      payments: [...payments.values()],
      listings: [...listings.values()],
      offers: [...offers.values()],
      matches: [...matches.values()],
      pool,
      listingSeq, offerSeq, matchSeq, partSeq,
    }, null, 2));
  } catch (e) { console.error('[store] save failed:', e.message); }
}
function load() {
  if (!DATA_FILE) return;
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    (data.users || []).forEach((u) => users.set(u.uid, u));
    (data.usedMergeIds || []).forEach((id) => usedMergeIds.add(id));
    (data.usedBattleIds || []).forEach((id) => usedBattleIds.add(id));
    (data.payments || []).forEach((p) => payments.set(p.paymentId, p));
    (data.listings || []).forEach((l) => listings.set(l.id, l));
    (data.offers || []).forEach((o) => offers.set(o.id, o));
    (data.matches || []).forEach((m) => matches.set(m.id, m));
    if (data.pool) Object.assign(pool, data.pool);
    if (data.listingSeq) listingSeq = data.listingSeq;
    if (data.offerSeq) offerSeq = data.offerSeq;
    if (data.matchSeq) matchSeq = data.matchSeq;
    if (data.partSeq) partSeq = data.partSeq;
  } catch (e) { console.error('[store] load failed:', e.message); }
}
load();

module.exports = {
  utcDay, addDays, weekKey,
  PART_TYPES, RARITIES, ABILITIES, INVENTORY_CAP, ETHEREAL_CAP, DRAW_ODDS, POOL_SHARE,
  getUser, publicUser, publicPart, machinePower,
  claimDaily, mergeParts, equipEthereal, doBattle, forgeCraft,
  previewBattle, rerollBattle, surrenderBattle, fightBattle,
  grantDraws, addToPool, getPool, weeklyPayout,
  matchRanking, leaderboard,
  recordPayment, setPaymentStatus, getPayment,
  createListing, listListings, getListing, completeShopSale,
  createOffer, listOffersFor, acceptOffer,
};
