'use strict';
// Agent passes: a trusted credential that builds a track record.
//   identity    one pass per customer and agent name. A handoff key is the agent's verified ID for one job; the pass
//               is its record across every job and every key, so history survives key rotation. Agents that only
//               name themselves (x-governance-agent) build no pass: a record needs a verified identity.
//   the record  every call through the gateway counts: clean answers, holds a person approved or denied, refusals,
//               and any pattern of agents acting together the agent was part of. Kept on disk, never the prompt or
//               the answer, only what happened and the receipt id.
//   standing    new      still building a record (fewer clean calls or days than the customer requires)
//               trusted  enough clean calls over enough days, and nothing against it in the watch period
//               watch    a denied hold, a refusal or a pattern in the watch period (default 30 days)
//               suspended a person pulled the pass: the agent's handoffs are revoked and new ones refused
//   what trust earns  renewal: a trusted agent's handoff can be extended without issuing a new key (the visa
//               renewal). Trust never skips a check: money holds, the source check and every rule still apply.
const fs = require('fs');
const path = require('path');
const DAY = 86400000;
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const nameKey = n => clean(n, 80).toLowerCase().replace(/\s+/g, ' ');

function store(dataDir) {
  const file = dataDir ? path.join(dataDir, 'gateway-passes.json') : null;
  let db = { passes: {} };
  try { if (file && fs.existsSync(file)) db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { db = { passes: {} }; }
  let dirty = false, timer = null;
  const save = now => { if (!file) return; dirty = true; if (now) return flush(); if (!timer) timer = setTimeout(flush, 500); };
  function flush() { if (timer) { clearTimeout(timer); timer = null; } if (!dirty || !file) return; dirty = false; try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(db), { mode: 0o600 }); } catch (e) {} }
  process.on('exit', flush);
  const P = db.passes;
  const id = (tenantId, agent) => tenantId + '|' + nameKey(agent);
  function get(tenantId, agent, create) {
    const k = id(tenantId, agent);
    if (!P[k] && create) P[k] = { key: k, tenantId, agent: clean(agent, 80), firstSeen: new Date().toISOString(), lastSeen: null, calls: 0, clean: 0, approved: 0, denied: 0, refused: 0, patterns: 0,
      marks: [], handoffs: [], suspended: null };
    return P[k] || null;
  }
  function standing(p, lim) {
    if (!p) return { standing: 'new', reason: 'No record yet.' };
    if (p.suspended) return { standing: 'suspended', reason: 'Suspended by ' + p.suspended.by + ' on ' + p.suspended.at.slice(0, 10) + ': ' + p.suspended.reason };
    const pick = (k, d) => lim && lim[k] != null ? lim[k] : d, now = Date.now(), watchDays = pick('watchDays', 30), needCalls = pick('trustCalls', 50), needDays = pick('trustDays', 7);
    const recent = p.marks.filter(m => now - Date.parse(m.at) < watchDays * DAY);
    if (recent.length) { const m = recent[recent.length - 1]; return { standing: 'watch', reason: recent.length + ' mark' + (recent.length === 1 ? '' : 's') + ' in the last ' + watchDays + ' days, the latest ' + m.what + ' on ' + m.at.slice(0, 10) + '.', until: new Date(Date.parse(m.at) + watchDays * DAY).toISOString() }; }
    const days = (now - Date.parse(p.firstSeen)) / DAY;
    if (p.clean >= needCalls && days >= needDays) return { standing: 'trusted', reason: p.clean + ' clean calls over ' + Math.floor(days) + ' days, nothing against it in the last ' + watchDays + ' days.' };
    return { standing: 'new', reason: 'Building a record: ' + p.clean + ' of ' + needCalls + ' clean calls, ' + Math.floor(days) + ' of ' + needDays + ' days.' };
  }
  const mark = (p, what, ref) => { p.marks.push({ at: new Date().toISOString(), what, ref: ref || null }); if (p.marks.length > 200) p.marks.splice(0, p.marks.length - 200); };
  return {
    nameKey, standing, flush,
    get: (t, a) => get(t, a, false),
    // a call by an agent under a handoff: clean, or a refusal (holds count when a person decides)
    call(tenantId, agent, handoffId, verdict, failed, receiptId) {
      const p = get(tenantId, agent, true); p.calls++; p.lastSeen = new Date().toISOString();
      if (handoffId && p.handoffs.indexOf(handoffId) === -1) { p.handoffs.push(handoffId); if (p.handoffs.length > 100) p.handoffs.shift(); }
      if (verdict === 'CERTIFIED' && !failed) p.clean++;
      else if (verdict === 'NO') { p.refused++; mark(p, 'a refused request', receiptId); }
      save();
    },
    decided(tenantId, agent, approved, holdId) { const p = get(tenantId, agent, true); if (approved) p.approved++; else { p.denied++; mark(p, 'a hold a person denied', holdId); } save(); },
    pattern(tenantId, agent, kind, receiptId) { const p = get(tenantId, agent, true); p.patterns++; mark(p, 'a pattern of agents acting together (' + kind + ')', receiptId); save(); },
    suspend(tenantId, agent, by, reason) { const p = get(tenantId, agent, true); p.suspended = { at: new Date().toISOString(), by: clean(by, 120), reason: clean(reason, 300) }; save(true); return p; },
    restore(tenantId, agent, by, reason) { const p = get(tenantId, agent, false); if (!p || !p.suspended) return null; mark(p, 'a restore after suspension by ' + clean(by, 120) + ' (' + clean(reason, 200) + ')', null); p.suspended = null; save(true); return p; },
    list(tenantId) { return Object.values(P).filter(p => !tenantId || p.tenantId === tenantId).sort((a, b) => String(b.lastSeen || b.firstSeen) < String(a.lastSeen || a.firstSeen) ? -1 : 1); },
    pub(p, lim) {
      const s = standing(p, lim);
      return { agent: p.agent, tenantId: p.tenantId, standing: s.standing, reason: s.reason, watchUntil: s.until || null, firstSeen: p.firstSeen, lastSeen: p.lastSeen, calls: p.calls, clean: p.clean,
        approved: p.approved, denied: p.denied, refused: p.refused, patterns: p.patterns, handoffs: p.handoffs.length, marks: p.marks.slice(-10).reverse(), suspended: p.suspended };
    }
  };
}
module.exports = { store, nameKey };
