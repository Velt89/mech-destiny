'use strict';
/**
 * Mech Destiny — frontend (Day-1 scaffold).
 *
 * Pi flow (per Pi docs):
 *   1. Load https://sdk.minepi.com/pi-sdk.js, then Pi.init({ version: '2.0', sandbox }).
 *   2. Pi.authenticate(['username','payments','wallet_address'], onIncompletePaymentFound)
 *      -> accessToken + user { uid, username } (presentation-only).
 *   3. POST /api/me { accessToken } -> backend verifies via Platform API GET /me.
 *      Only the verified uid is trusted; the frontend user object is never sent
 *      to the backend as proof of identity.
 *   4. Payments: Pi.createPayment(...) with server approve/complete callbacks
 *      hitting /api/payment-approve and /api/payment-complete. Rewards are granted
 *      server-side only after the complete call succeeds. Draws and shop buys
 *      are distinguished by metadata.kind ('draw' | 'shop-buy').
 *
 * PiNet behaviour: outside Pi Browser window.Pi is undefined. The page stays
 * fully readable (browse-only surface) and Pi-gated actions show "open in Pi
 * Browser" instead of failing. Guest preview lets anyone try the game locally.
 */

const PI_SDK_URL = 'https://sdk.minepi.com/pi-sdk.js';
const DRAW_PRICES = { standard: 0.5, forge: 1, pack10: 9 };

const $ = (id) => document.getElementById(id);
const state = {
  sandbox: true,
  serverKeyConfigured: false,
  piReady: false, // Pi SDK loaded AND window.Pi exists (i.e. Pi Browser)
  user: null, // { uid, username, verified, guest }
  profile: null, // last /api/checkin user record
  parts: [], // last /api/inventory parts
  selected: new Set(), // part ids ticked for merging
};

function msg(el, text, isErr) {
  el.textContent = text;
  el.classList.toggle('err', !!isErr);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- Pi SDK ----------
function loadPiSdk() {
  return new Promise((resolve) => {
    if (window.Pi) return resolve(true);
    const s = document.createElement('script');
    s.src = PI_SDK_URL;
    s.onload = () => resolve(!!window.Pi);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

async function initPi() {
  const status = await api('/api/status').catch(() => ({ sandbox: true }));
  state.sandbox = status.sandbox !== false;
  state.serverKeyConfigured = !!status.serverKeyConfigured;
  $('envBadge').textContent = state.sandbox ? 'SANDBOX — no real Pi' : 'LIVE — real Pi';

  const sdkLoaded = await loadPiSdk();
  if (sdkLoaded && window.Pi) {
    try {
      window.Pi.init({ version: '2.0', sandbox: state.sandbox });
      state.piReady = true;
      $('piStatusTitle').textContent = 'Pi Browser detected';
      $('piStatusText').textContent = state.sandbox
        ? 'Pi SDK ready in Sandbox mode — sign in to test auth and payments without moving real Pi.'
        : 'Pi SDK ready (live mode). Payments move real Pi — only after Sandbox testing passes.';
      $('signInBtn').disabled = false;
    } catch (e) {
      $('piStatusTitle').textContent = 'Pi SDK failed to initialise';
      $('piStatusText').textContent = String(e && e.message || e);
    }
  } else {
    // PiNet / regular browser: browse-only. Nothing here calls Pi.*.
    $('piStatusTitle').textContent = 'Browsing without Pi Browser (PiNet view)';
    $('piStatusText').textContent = 'You can read everything and try the game as a guest. To sign in, check in, or pay with Pi, open this page in Pi Browser and create a Pi account.';
  }
  await refreshLeaderboard();
  await refreshPool();
}

/** Complete an interrupted payment found by the SDK (required by Pi docs). */
async function onIncompletePaymentFound(payment) {
  try {
    if (!state.user) return;
    await api('/api/payment-complete', {
      method: 'POST',
      body: {
        paymentId: payment.identifier,
        txid: payment.transaction && payment.transaction.txid,
        uid: state.user.uid,
        username: state.user.username,
      },
    });
  } catch (e) {
    console.error('incomplete payment could not be completed:', e);
  }
}

async function signIn() {
  if (!state.piReady) return;
  msg($('authState'), 'Opening Pi sign-in…');
  try {
    const auth = await window.Pi.authenticate(
      ['username', 'payments', 'wallet_address'],
      onIncompletePaymentFound,
    );
    // Verify server-side: POST /api/me. Never trust auth.user on its own.
    const verified = await api('/api/me', { method: 'POST', body: { accessToken: auth.accessToken } });
    if (!verified.verified) {
      msg($('authState'), `Signed in with Pi, but the backend could not verify you: ${verified.note || 'unknown reason'}`, true);
      return;
    }
    state.user = { uid: verified.uid, username: verified.username, verified: true, guest: false };
    $('authState').textContent = `Signed in as ${verified.username} (Pi-verified${verified.mock ? ', sandbox mock' : ''}).`;
    afterSignedIn();
  } catch (e) {
    msg($('authState'), `Pi sign-in failed: ${e && e.message || e}`, true);
  }
}

function signInAsGuest() {
  let guest = JSON.parse(localStorage.getItem('md-guest') || 'null');
  if (!guest) {
    guest = { uid: 'guest-' + Math.random().toString(36).slice(2, 10), username: 'Guest' };
    localStorage.setItem('md-guest', JSON.stringify(guest));
  }
  state.user = { ...guest, verified: false, guest: true };
  $('authState').textContent = 'Guest preview — progress is stored locally under a guest id, not a Pi account. Sign in with Pi to keep it.';
  afterSignedIn();
}

function afterSignedIn() {
  $('signInBtn').disabled = true;
  $('guestBtn').disabled = true;
  $('checkinBtn').disabled = false;
  $('battleBtn').disabled = false;
  $('forgeBtn').disabled = false;
  $('listBtn').disabled = false;
  $('drawStandardBtn').disabled = !state.piReady;
  $('drawForgeBtn').disabled = !state.piReady;
  $('drawPackBtn').disabled = !state.piReady;
  $('profileBox').hidden = false;
  refreshAll();
}

function refreshAll() {
  refreshProfile();
  refreshInventory();
  refreshDraw();
  refreshShop();
  refreshLeaderboard();
  refreshPool();
}

// ---------- profile / check-in / leaderboard / pool ----------
function renderProfile(user) {
  if (!user) return;
  state.profile = user;
  $('profileName').textContent = user.username;
  $('profileStreak').textContent = `${user.streak} day${user.streak === 1 ? '' : 's'} (best ${user.bestStreak})`;
  $('profileBest').textContent = user.bestStreak;
  $('profilePoints').textContent = user.points;
  $('profileMachine').textContent = user.hasMachine ? 'Base Machine' : 'No machine yet — check in!';
  $('profileParts').textContent = `${user.partsCount} / ${user.inventoryCap}`;
  $('profilePower').textContent = user.machinePower;
  $('profileFragments').textContent = user.fragments;
  $('profileWins').textContent = `${user.wins}–${user.losses} (streak ${user.winStreak}, weekly ${user.weeklyWins})`;
  $('profileFate').textContent = `${user.drawsWithoutEthereal} draws since Ethereal (Legendary+ in ${Math.max(0, 11 - user.drawsWithoutEthereal)}, Ethereal in ${Math.max(0, 31 - user.drawsWithoutEthereal)})`;
  $('profileBalance').textContent = `${user.piBalance.toFixed(2)} π`;
}

async function refreshProfile() {
  if (!state.user) return;
  // The profile is returned by check-in; refresh it cheaply via a no-op
  // check-in read: if already claimed today it returns the current record.
  try {
    const r = await api('/api/checkin', { method: 'POST', body: { uid: state.user.uid, username: state.user.username } });
    renderProfile(r.user);
  } catch (e) { /* profile refresh is best-effort */ }
}

async function checkin() {
  if (!state.user) return;
  try {
    const r = await api('/api/checkin', { method: 'POST', body: { uid: state.user.uid, username: state.user.username } });
    renderProfile(r.user);
    msg($('checkinMsg'), r.alreadyClaimed
      ? `Already checked in today — streak ${r.user.streak}, come back tomorrow (UTC).`
      : `Checked in! Streak ${r.user.streak}, +${r.bonus} points${r.part ? `, new ${r.part.rarity} ${r.part.type} (P${r.part.power} S${r.part.speed} A${r.part.armor})` : ''}${r.inventoryFull ? ' — inventory full, no part this time.' : ''}`);
    await refreshInventory();
    await refreshLeaderboard();
  } catch (e) {
    msg($('checkinMsg'), `Check-in failed: ${e.message}`, true);
  }
}

async function refreshLeaderboard() {
  try {
    const r = await api('/api/leaderboard?limit=20');
    $('leaderboard').innerHTML = r.matchRanking.length
      ? r.matchRanking.map((u) => `<li><strong>${escapeHtml(u.username)}</strong> — ${u.weeklyWins} wins this week · ${u.wins}–${u.losses} · Power ${u.machinePower}</li>`).join('')
      : '<li>No Pioneers yet — be the first to check in.</li>';
  } catch (e) {
    $('leaderboard').innerHTML = '<li>Leaderboard unavailable.</li>';
  }
}

async function refreshPool() {
  try {
    const p = await api('/api/pool');
    $('poolText').textContent = `Reward pool: ${p.totalPi.toFixed(2)} π total (10% of every pay draw) · ${p.paidOutPi.toFixed(2)} π paid out so far. Weekly top 3 split 10% of the pool (5% / 3% / 2%).`;
  } catch (e) {
    $('poolText').textContent = 'Reward pool unavailable.';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- inventory / merge / equip ----------
function partLabel(p) {
  return `${p.rarity} ${p.type} — P${p.power} S${p.speed} A${p.armor}${p.ability ? ` · ${p.ability}` : ''}${p.equipped ? ' · EQUIPPED' : ''}`;
}

async function refreshInventory() {
  if (!state.user) return;
  try {
    const r = await api(`/api/inventory?uid=${encodeURIComponent(state.user.uid)}`);
    state.parts = r.parts;
    renderProfile(r.user);
    const list = $('inventoryList');
    if (!r.parts.length) {
      list.innerHTML = '<p>No parts yet — check in to get your first part.</p>';
    } else {
      list.innerHTML = r.parts.map((p) => {
        const checked = state.selected.has(p.id) ? 'checked' : '';
        return `<label class="part"><input type="checkbox" data-part-id="${escapeHtml(p.id)}" ${checked}> ${escapeHtml(partLabel(p))}</label>`;
      }).join('');
      list.querySelectorAll('input[type=checkbox]').forEach((cb) => {
        cb.addEventListener('change', () => {
          if (cb.checked) state.selected.add(cb.dataset.partId); else state.selected.delete(cb.dataset.partId);
          updateMergeBtn();
        });
      });
    }
    // Forge select: Legendary parts only.
    const legs = r.parts.filter((p) => p.rarity === 'Legendary');
    $('forgeSelect').innerHTML = legs.length
      ? legs.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(partLabel(p))}</option>`).join('')
      : '<option value="">(no Legendary part yet)</option>';
    // Shop list select: any part.
    $('listPartSelect').innerHTML = r.parts.length
      ? r.parts.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(partLabel(p))}</option>`).join('')
      : '<option value="">(no parts yet)</option>';
    updateMergeBtn();
  } catch (e) {
    $('inventoryList').innerHTML = '<p>Inventory unavailable.</p>';
  }
}

function updateMergeBtn() {
  $('mergeBtn').disabled = state.selected.size !== 2;
  $('selectedCount').textContent = state.selected.size ? `${state.selected.size} selected` : '';
}

async function mergeSelected() {
  if (!state.user || state.selected.size !== 2) return;
  const partIds = [...state.selected];
  try {
    const r = await api('/api/merge', { method: 'POST', body: { uid: state.user.uid, username: state.user.username, partIds, mergeId: crypto.randomUUID() } });
    state.selected.clear();
    renderProfile(r.user);
    msg($('mergeMsg'), `Merged! New ${r.result.rarity} ${r.result.type} (P${r.result.power} S${r.result.speed} A${r.result.armor}), +${r.points} points.`);
    await refreshInventory();
    await refreshLeaderboard();
  } catch (e) {
    msg($('mergeMsg'), `Merge failed: ${e.message}`, true);
  }
}

async function toggleEquip(partId, equip) {
  if (!state.user) return;
  try {
    const r = await api('/api/equip', { method: 'POST', body: { uid: state.user.uid, username: state.user.username, partId, equip } });
    renderProfile(r.user);
    msg($('equipMsg'), equip ? `Equipped ${r.part.rarity} ${r.part.type} (${r.part.ability}).` : `Unequipped ${r.part.rarity} ${r.part.type}.`);
    await refreshInventory();
  } catch (e) {
    msg($('equipMsg'), `Equip failed: ${e.message}`, true);
  }
}

// ---------- battle / forge ----------
async function battle() {
  if (!state.user) return;
  try {
    const r = await api('/api/battle', { method: 'POST', body: { uid: state.user.uid, username: state.user.username, battleId: crypto.randomUUID() } });
    renderProfile(r.user);
    msg($('battleMsg'), r.won
      ? `You won vs ${r.rivalName}! Score ${r.myScore}–${r.rivalScore}. ${r.partWon ? `Took their ${r.partWon.rarity} ${r.partWon.type}.` : 'Inventory full — no spoils part.'} +Blueprint Fragment(s): ${r.fragments} total.`
      : `You lost vs ${r.rivalName}. Score ${r.myScore}–${r.rivalScore}. ${r.shieldSaved ? 'Shield saved your part this time.' : r.partLost ? `Lost your ${r.partLost.rarity} ${r.partLost.type}.` : 'No part to lose.'}`);
    await refreshInventory();
    await refreshLeaderboard();
  } catch (e) {
    msg($('battleMsg'), `Battle failed: ${e.message}`, true);
  }
}

async function forge() {
  if (!state.user) return;
  const legendaryPartId = $('forgeSelect').value;
  if (!legendaryPartId) { msg($('forgeMsg'), 'You need a Legendary part to forge — merge parts up to Legendary first.', true); return; }
  try {
    const r = await api('/api/forge', { method: 'POST', body: { uid: state.user.uid, username: state.user.username, legendaryPartId } });
    renderProfile(r.user);
    msg($('forgeMsg'), `Forged! Ethereal ${r.result.type} with ${r.result.ability} (P${r.result.power} S${r.result.speed} A${r.result.armor}). Fragments left: ${r.fragments}.`);
    await refreshInventory();
  } catch (e) {
    msg($('forgeMsg'), `Forge failed: ${e.message}`, true);
  }
}

// ---------- draws ----------
async function refreshDraw() {
  if (!state.user) return;
  try {
    const r = await api(`/api/draw?uid=${encodeURIComponent(state.user.uid)}`);
    $('fateText').textContent = `Ethereal Fate: ${r.etherealFate.drawsWithoutEthereal} draws since your last Ethereal — guaranteed Legendary+ in ${r.etherealFate.drawsToLegendaryPlus} draw(s), guaranteed Ethereal in ${r.etherealFate.drawsToEthereal} draw(s). Inventory room: ${r.inventoryRoom} parts.`;
  } catch (e) { /* best-effort */ }
}

function buyDraw(drawType) {
  if (!state.piReady || !state.user || state.user.guest) {
    msg($('drawMsg'), 'Pay draws need Pi sign-in inside Pi Browser.', true);
    return;
  }
  if (!state.sandbox) {
    msg($('drawMsg'), 'Live payments are disabled in this scaffold until Sandbox testing passes. See README.', true);
    return;
  }
  const price = DRAW_PRICES[drawType];
  const label = drawType === 'standard' ? 'Standard Draw' : drawType === 'forge' ? 'Ethereal Forge' : '10-pack';
  if (!confirm(`Buy ${label} for ${price} π? (Sandbox test — no real Pi moves. Minimum drop: Rare.)`)) return;
  msg($('drawMsg'), 'Creating Pi payment…');
  createPiPayment(
    { amount: price, memo: `Mech Destiny: ${label}`, metadata: { kind: 'draw', drawType } },
    {
      onComplete: async (r) => {
        renderProfile(r.draws.user);
        const names = r.draws.granted.map((p) => `${p.rarity} ${p.type}`).join(', ');
        msg($('drawMsg'), `Draw complete — you got: ${names}. Pool is now ${r.poolTotal.toFixed(2)} π.${r.simulated ? ' (Sandbox simulation.)' : ''}`);
        // Await the refreshes so the inventory list AND the shop sell-dropdown
        // both contain the newly drawn part before the user can act on it.
        // (Bug 2026-11-26: fire-and-forget refreshes left the sell dropdown
        // stale, so listing a just-drawn part failed with "not in your
        // inventory" until a full page refresh.)
        await refreshInventory();
        await refreshDraw();
        await refreshPool();
        await refreshShop();
      },
    },
  );
}

// ---------- shop ----------
async function refreshShop() {
  try {
    const r = await api(`/api/shop${state.user ? `?uid=${encodeURIComponent(state.user.uid)}` : ''}`);
    $('shopListings').innerHTML = r.listings.length
      ? r.listings.map((l) => `<div class="listing"><strong>${escapeHtml(l.part ? partLabel(l.part) : 'part')}</strong> — ${l.pricePi} π by ${escapeHtml(l.sellerUsername)} <button class="btn buy-listing" data-listing-id="${escapeHtml(l.id)}" data-price="${l.pricePi}" ${state.user && l.sellerUid === state.user.uid ? 'disabled' : ''}>Buy</button></div>`).join('')
      : '<p>No listings yet.</p>';
    $('shopListings').querySelectorAll('.buy-listing').forEach((btn) => {
      btn.addEventListener('click', () => buyListing(btn.dataset.listingId, Number(btn.dataset.price)));
    });
    $('shopOffers').innerHTML = r.offersForYou.length
      ? r.offersForYou.map((o) => `<div class="listing"><strong>${escapeHtml(o.fromUsername)}</strong> offers ${escapeHtml(o.offeredPart ? partLabel(o.offeredPart) : 'a part')} for ${o.wantedPart ? escapeHtml(partLabel(o.wantedPart)) : `${o.pricePi} π`} <button class="btn accept-offer" data-offer-id="${escapeHtml(o.id)}">Accept</button></div>`).join('')
      : '<p>No offers for you yet.</p>';
    $('shopOffers').querySelectorAll('.accept-offer').forEach((btn) => {
      btn.addEventListener('click', () => acceptOffer(btn.dataset.offerId));
    });
  } catch (e) {
    $('shopListings').innerHTML = '<p>Shop unavailable.</p>';
  }
}

async function createListing() {
  if (!state.user) return;
  const partId = $('listPartSelect').value;
  const pricePi = Number($('listPrice').value);
  if (!partId) { msg($('shopMsg'), 'Pick a part to sell first.', true); return; }
  if (!Number.isFinite(pricePi) || pricePi <= 0) { msg($('shopMsg'), 'Set a positive price in π.', true); return; }
  try {
    // Re-check ownership against a fresh inventory read first, so a part
    // granted moments ago (draw/battle/forge) is never rejected as "not in
    // your inventory" because the sell-dropdown was built from stale data.
    const inv = await api(`/api/inventory?uid=${encodeURIComponent(state.user.uid)}`);
    state.parts = inv.parts;
    if (!inv.parts.some((p) => p.id === partId)) {
      await refreshInventory();
      msg($('shopMsg'), 'That part is not in your inventory yet — refreshed the list, pick it again.', true);
      return;
    }
    await api('/api/shop', { method: 'POST', body: { action: 'create-listing', uid: state.user.uid, username: state.user.username, partId, pricePi } });
    msg($('shopMsg'), `Listed for ${pricePi} π.`);
    await refreshShop();
    await refreshInventory();
  } catch (e) {
    msg($('shopMsg'), `Listing failed: ${e.message}`, true);
  }
}

function buyListing(listingId, price) {
  if (!state.piReady || !state.user || state.user.guest) {
    msg($('shopMsg'), 'Buying needs Pi sign-in inside Pi Browser.', true);
    return;
  }
  if (!state.sandbox) {
    msg($('shopMsg'), 'Live payments are disabled in this scaffold until Sandbox testing passes. See README.', true);
    return;
  }
  if (!confirm(`Buy this part for ${price} π? (Sandbox test — no real Pi moves.)`)) return;
  msg($('shopMsg'), 'Creating Pi payment…');
  createPiPayment(
    { amount: price, memo: 'Mech Destiny: shop purchase', metadata: { kind: 'shop-buy', listingId } },
    {
      onComplete: async (r) => {
        renderProfile(r.sale.user);
        msg($('shopMsg'), `Bought ${r.sale.part.rarity} ${r.sale.part.type} for ${r.sale.pricePi} π.${r.simulated ? ' (Sandbox simulation.)' : ''}`);
        await refreshInventory();
        await refreshShop();
      },
    },
  );
}

async function acceptOffer(offerId) {
  if (!state.user) return;
  try {
    const r = await api('/api/shop', { method: 'POST', body: { action: 'accept-offer', uid: state.user.uid, username: state.user.username, offerId } });
    renderProfile(r.user);
    msg($('shopMsg'), 'Offer accepted — the parts changed hands.');
    await refreshInventory();
    await refreshShop();
  } catch (e) {
    msg($('shopMsg'), `Accept failed: ${e.message}`, true);
  }
}

// ---------- Pi payments (Sandbox-safe, shared by draws + shop) ----------
async function createPiPayment(paymentData, { onComplete }) {
  if (!state.piReady || !state.user) return;
  try {
    await window.Pi.createPayment(
      paymentData,
      {
        onReadyForServerApproval: async (paymentId) => {
          await api('/api/payment-approve', {
            method: 'POST',
            body: { paymentId, uid: state.user.uid, amount: paymentData.amount, kind: paymentData.metadata.kind, drawType: paymentData.metadata.drawType, listingId: paymentData.metadata.listingId },
          });
        },
        onReadyForServerCompletion: async (paymentId, txid) => {
          const r = await api('/api/payment-complete', { method: 'POST', body: { paymentId, txid, uid: state.user.uid, username: state.user.username } });
          await onComplete(r);
        },
        onCancel: (paymentId) => msg($('drawMsg'), `Payment cancelled (${paymentId}). Nothing granted.`, true),
        onError: (error) => msg($('drawMsg'), `Payment error: ${error && error.message || error}`, true),
      },
    );
  } catch (e) {
    msg($('drawMsg'), `Payment failed: ${e && e.message || e}`, true);
  }
}

// ---------- wire up ----------
document.addEventListener('DOMContentLoaded', () => {
  $('signInBtn').addEventListener('click', signIn);
  $('guestBtn').addEventListener('click', signInAsGuest);
  $('checkinBtn').addEventListener('click', checkin);
  $('mergeBtn').addEventListener('click', mergeSelected);
  $('battleBtn').addEventListener('click', battle);
  $('forgeBtn').addEventListener('click', forge);
  $('drawStandardBtn').addEventListener('click', () => buyDraw('standard'));
  $('drawForgeBtn').addEventListener('click', () => buyDraw('forge'));
  $('drawPackBtn').addEventListener('click', () => buyDraw('pack10'));
  $('listBtn').addEventListener('click', createListing);
  $('refreshLbBtn').addEventListener('click', () => { refreshLeaderboard(); refreshPool(); });
  // Equip toggle: clicking an Ethereal's checkbox label twice is confusing, so
  // equipping is done from the inventory via double-click on a part row.
  $('inventoryList').addEventListener('dblclick', (e) => {
    const cb = e.target.closest('label.part');
    if (!cb) return;
    const input = cb.querySelector('input[type=checkbox]');
    if (!input) return;
    const part = state.parts.find((p) => p.id === input.dataset.partId);
    if (part && part.rarity === 'Ethereal') toggleEquip(part.id, !part.equipped);
  });
  initPi();
});
