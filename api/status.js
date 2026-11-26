'use strict';
const { sendJson, methodNotAllowed } = require('./_lib/http');
const pi = require('./_lib/pi');
const store = require('./_lib/store');

/** GET /api/status — public config surface. Never leaks the Server API Key. */
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  sendJson(res, 200, {
    app: 'Mech Destiny (working title)',
    hackathon: 'Pi Next 2026',
    sandbox: pi.isSandbox(),
    serverKeyConfigured: pi.hasServerKey(),
    store: store.storeMode(), // 'kv' (shared, Vercel) or 'memory' (local dev only)
    piSdkUrl: 'https://sdk.minepi.com/pi-sdk.js',
    piSdkVersion: '2.0',
    economy: {
      partTypes: store.PART_TYPES,
      rarities: store.RARITIES,
      abilities: store.ABILITIES,
      inventoryCap: store.INVENTORY_CAP,
      etherealCap: store.ETHEREAL_CAP,
      dailyCheckinPoints: 50,
      streakBonusPerDay: 10,
      streakBonusCap: 70,
      streakMilestones: { 3: 'Rare', 7: 'Epic', 14: 'Legendary' },
      mergePoints: 25,
      mergePointsEpicPlus: 50,
      freeBattlesPerDay: 1,
      forgeFragments: 5,
      draws: store.DRAW_ODDS,
      etherealFate: { legendaryPlusAt: 11, etherealAt: 31 },
      poolShare: store.POOL_SHARE,
      weeklyPayoutSplit: [0.05, 0.03, 0.02],
    },
    note: pi.isSandbox()
      ? 'Sandbox mode — Pi SDK payments move no real Pi.'
      : 'LIVE mode — real Pi payments. Enable only after Sandbox testing passes.',
  });
};
