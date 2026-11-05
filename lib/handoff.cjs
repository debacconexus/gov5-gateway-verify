'use strict';
// Agent handoffs: a chain of custody for work passed from one agent to another.
//   An agent never needs the customer's master key. It gets a handoff key (gwh_) that says who it is acting for, for what
//   purpose, which tools it may use, how much it may spend and until when. An agent can hand work on only within its own
//   powers: the same or fewer tools, no more than its remaining budget, no later expiry, and at most five levels deep.
//   Every handoff is receipted; every call made with a handoff key names the whole chain back to the customer key that
//   started it. Revoking a handoff revokes everything handed on from it.
//   Agent charter: every handoff can name the living person who owns the work (inherited down the chain), whether the
//   agent may start other agents and how many, and when it was last seen, so a sleeping agent that wakes is caught.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const MAX_DEPTH = 5, MAX_TTL = 30 * 86400, DEFAULT_TTL = 3600;
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

function store(dataDir) {
  const file = dataDir ? path.join(dataDir, 'gateway-handoffs.json') : null;
  let db = { handoffs: {} };
  try { if (file && fs.existsSync(file)) db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { db = { handoffs: {} }; }
  const save = () => { if (!file) return; try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(db), { mode: 0o600 }); } catch (e) {} };
  const H = db.handoffs;
  const status = h => h.revoked ? 'revoked' : Date.parse(h.expiresAt) <= Date.now() ? 'expired' : 'active';
  const remaining = h => h.spendLimitUsd == null ? null : Math.max(0, h.spendLimitUsd - h.spentUsd);
  const chain = h => { const out = []; let x = h; while (x && out.length < 10) { out.unshift(x); x = x.parent ? H[x.parent] : null; } return out; };
  const ownerOf = h => { for (let x = h; x; x = x.parent ? H[x.parent] : null) if (x.owner) return x.owner; return null; };
  const taskOf = h => { for (let x = h; x; x = x.parent ? H[x.parent] : null) if (x.taskWords && x.taskWords.length) return x.taskWords; return null; };
  const pub = h => ({ id: h.id, tenantId: h.tenantId, parent: h.parent, parentReceiptId: h.parentReceiptId, fromAgent: h.fromAgent, toAgent: h.toAgent, purpose: h.purpose,
    allowedTools: h.allowedTools, spendLimitUsd: h.spendLimitUsd, spentUsd: +h.spentUsd.toFixed(6), remainingUsd: remaining(h) == null ? null : +remaining(h).toFixed(6), calls: h.calls,
    depth: h.depth, createdAt: h.createdAt, expiresAt: h.expiresAt, status: status(h), revokedAt: h.revokedAt || null, revokedBy: h.revokedBy || null, issueReceiptId: h.issueReceiptId || null,
    keyPrefix: h.keyPrefix, issuedBy: h.issuedBy, owner: ownerOf(h), taskWords: taskOf(h), maySpawn: h.maySpawn !== false, maxChildren: h.maxChildren == null ? null : h.maxChildren, lastSeenAt: h.lastSeenAt || null });
  return {
    status, chain, pub, remaining, ownerOf, taskOf,
    // spec: { toAgent, fromAgent, purpose, allowedTools, spendLimitUsd, expiresInSec, parentReceiptId }; parent: handoff or null
    create(tenantId, spec, parent, issuedBy) {
      spec = spec || {};
      const toAgent = clean(spec.toAgent, 80), purpose = clean(spec.purpose, 300);
      if (!toAgent || !purpose) return { error: 'toAgent and purpose are required.' };
      let tools = spec.allowedTools == null ? null : (Array.isArray(spec.allowedTools) ? spec.allowedTools : String(spec.allowedTools).split(/[\s,]+/)).map(s => clean(s, 128)).filter(s => /^[A-Za-z0-9_.:\/-]{1,128}$/.test(s));
      let limit = spec.spendLimitUsd == null || spec.spendLimitUsd === '' ? null : Number(spec.spendLimitUsd);
      if (limit != null && !(Number.isFinite(limit) && limit >= 0 && limit <= 1e7)) return { error: 'spendLimitUsd must be a number of dollars.' };
      let ttl = spec.expiresInSec == null ? DEFAULT_TTL : Number(spec.expiresInSec);
      if (!(Number.isFinite(ttl) && ttl >= 1 && ttl <= MAX_TTL)) return { error: 'expiresInSec must be between 1 second and 30 days.' };
      let expires = Date.now() + ttl * 1000, depth = 1;
      if (parent) {
        if (parent.tenantId !== tenantId) return { error: 'Parent handoff belongs to another customer.' };
        if (status(parent) !== 'active') return { error: 'The parent handoff is ' + status(parent) + '.' };
        // the charter says whether this agent may start other agents, and how many
        if (parent.maySpawn === false) return { error: parent.toAgent + '\'s charter does not allow it to start other agents.', spawnRefused: true };
        if (parent.maxChildren != null && Object.values(H).filter(c => c.parent === parent.id).length >= parent.maxChildren) return { error: parent.toAgent + '\'s charter allows at most ' + parent.maxChildren + ' other agent' + (parent.maxChildren === 1 ? '' : 's') + '.', spawnRefused: true };
        depth = parent.depth + 1; if (depth > MAX_DEPTH) return { error: 'Handoffs can go at most ' + MAX_DEPTH + ' levels deep.' };
        // an agent can only hand on what it holds
        if (parent.allowedTools) {
          if (tools == null) tools = parent.allowedTools.slice();
          const extra = tools.filter(t => parent.allowedTools.indexOf(t) === -1);
          if (extra.length) return { error: 'Cannot hand on tools the parent does not hold: ' + extra.join(', ') + '.' };
        }
        const rem = remaining(parent);
        if (rem != null) { if (limit == null) limit = rem; if (limit > rem + 1e-9) return { error: 'Cannot hand on more budget than remains ($' + rem.toFixed(4) + ').' }; }
        expires = Math.min(expires, Date.parse(parent.expiresAt));
      }
      const maySpawn = !(spec.maySpawn === false || spec.maySpawn === 'false');
      let maxChildren = spec.maxChildren == null || spec.maxChildren === '' ? null : Number(spec.maxChildren);
      if (maxChildren != null && !(Number.isInteger(maxChildren) && maxChildren >= 0 && maxChildren <= 1000)) return { error: 'maxChildren must be a whole number from 0 to 1000.' };
      if (parent && parent.maxChildren != null) maxChildren = maxChildren == null ? parent.maxChildren : Math.min(maxChildren, parent.maxChildren);
      const owner = clean(spec.owner, 120) || null;
      // the agent's job, as words: a request with none of them is off task (inherited, and a helper can only narrow it)
      let taskWords = spec.taskWords == null || spec.taskWords === '' ? null : (Array.isArray(spec.taskWords) ? spec.taskWords : String(spec.taskWords).split(/[,\n]+/)).map(w => clean(w, 40).toLowerCase()).filter(w => w.length >= 3).slice(0, 30);
      if (taskWords && !taskWords.length) taskWords = null;
      const id = 'hf_' + crypto.randomBytes(8).toString('hex'), token = 'gwh_' + crypto.randomBytes(24).toString('hex');
      H[id] = { id, tenantId, parent: parent ? parent.id : null, parentReceiptId: clean(spec.parentReceiptId, 40) || null, fromAgent: clean(spec.fromAgent, 80) || (parent ? parent.toAgent : 'customer key'),
        toAgent, purpose, allowedTools: tools, spendLimitUsd: limit, spentUsd: 0, calls: 0, receipts: [], depth, createdAt: new Date().toISOString(), expiresAt: new Date(expires).toISOString(),
        revoked: false, owner, maySpawn, maxChildren, taskWords, tokenHash: sha(token), keyPrefix: token.slice(0, 10), issuedBy: clean(issuedBy, 120) };
      save(); return { handoff: H[id], token };
    },
    // renewal: extend an active handoff by its own original length (at most 30 days), never past its parent's expiry
    renew(id) {
      const h = H[id]; if (!h) return { error: 'Handoff not found.' };
      if (status(h) !== 'active') return { error: 'The handoff is ' + status(h) + '.' };
      const len = Math.min(MAX_TTL * 1000, Math.max(60000, Date.parse(h.expiresAt) - Date.parse(h.createdAt)));
      let until = Date.now() + len;
      for (let x = h.parent ? H[h.parent] : null; x; x = x.parent ? H[x.parent] : null) until = Math.min(until, Date.parse(x.expiresAt));
      if (until <= Date.parse(h.expiresAt)) return { error: 'It cannot be extended past the handoff above it (' + h.expiresAt + ').' };
      h.renewals = (h.renewals || 0) + 1; h.expiresAt = new Date(until).toISOString(); save(); return { handoff: h };
    },
    // a call was seen under this handoff; returns how long it had been quiet (ms) before this call
    touch(id) { const h = H[id]; if (!h) return 0; const quiet = Date.now() - Date.parse(h.lastSeenAt || h.createdAt); h.lastSeenAt = new Date().toISOString(); save(); return quiet; },
    quietFor(id) { const h = H[id]; return h ? Date.now() - Date.parse(h.lastSeenAt || h.createdAt) : 0; },
    // stop every active agent for a customer at once
    stopAll(tenantId, by) { let n = 0; const at = new Date().toISOString(); Object.values(H).forEach(h => { if (h.tenantId === tenantId && !h.revoked && status(h) === 'active') { h.revoked = true; h.revokedAt = at; h.revokedBy = clean(by, 120); n++; } }); save(); return n; },
    setIssueReceipt(id, rid) { if (H[id]) { H[id].issueReceiptId = rid; save(); } },
    byToken(token) { const h = sha(token); return Object.values(H).find(x => x.tokenHash === h) || null; },
    get(id) { return H[id] || null; },
    list(tenantId) { return Object.values(H).filter(h => !tenantId || h.tenantId === tenantId).sort((a, b) => a.createdAt < b.createdAt ? 1 : -1); },
    children(id) { return Object.values(H).filter(h => h.parent === id); },
    // revoking a handoff revokes everything handed on from it
    revoke(id, by) {
      const h = H[id]; if (!h) return 0; let n = 0; const at = new Date().toISOString();
      const walk = x => { if (!x.revoked) { x.revoked = true; x.revokedAt = at; x.revokedBy = clean(by, 120); n++; } Object.values(H).filter(c => c.parent === x.id).forEach(walk); };
      walk(h); save(); return n;
    },
    // spend under a handoff counts against it and every handoff above it
    addSpend(id, usd, receiptId) {
      let x = H[id], first = true;
      while (x) { x.spentUsd += usd || 0; if (first) { x.calls++; x.receipts.push(receiptId); if (x.receipts.length > 200) x.receipts.shift(); first = false; } x = x.parent ? H[x.parent] : null; }
      save();
    },
    // pre-model check rows for a call made with a handoff key
    check(h, offeredTools, worstUsd, action) {
      const st = status(h), c = chain(h), path = c.map(x => x.toAgent).join(' > ');
      const base = { id: 'handoff', stage: 'pre-model (authority)', label: 'Agent handoff: who this agent acts for', chain: c.map(x => ({ id: x.id, from: x.fromAgent, to: x.toAgent, purpose: x.purpose })), handoffId: h.id, depth: h.depth };
      if (st !== 'active') return Object.assign(base, { result: 'fail', action: 'NO', detail: 'Handoff ' + h.id + ' (' + h.toAgent + ') is ' + st + '. Chain: customer key > ' + path + '.' });
      // every link in the chain must still be active
      const dead = c.find(x => status(x) !== 'active');
      if (dead) return Object.assign(base, { result: 'fail', action: 'NO', detail: 'A handoff above this one (' + dead.id + ', ' + dead.toAgent + ') is ' + status(dead) + '.' });
      const extra = h.allowedTools ? offeredTools.filter(t => h.allowedTools.indexOf(t) === -1) : [];
      if (extra.length) return Object.assign(base, { result: 'fail', action, detail: h.toAgent + ' was not handed these tools: ' + extra.join(', ') + '. Chain: customer key > ' + path + '.' });
      const tight = c.map(x => remaining(x)).filter(r => r != null), rem = tight.length ? Math.min.apply(null, tight) : null;
      if (rem != null && worstUsd > rem + 1e-12) return Object.assign(base, { result: 'fail', action, detail: 'This request could cost up to $' + worstUsd.toFixed(4) + '; the handoff chain has $' + rem.toFixed(4) + ' left.' });
      return Object.assign(base, { result: 'pass', detail: h.toAgent + ' acting for ' + h.fromAgent + ' under ' + h.id + ' (depth ' + h.depth + '), purpose: ' + h.purpose + '. Chain: customer key > ' + path + '.' + (rem != null ? ' Budget left: $' + rem.toFixed(4) + '.' : '') + ' Expires ' + h.expiresAt + '.' });
    }
  };
}
module.exports = { store, MAX_DEPTH };
