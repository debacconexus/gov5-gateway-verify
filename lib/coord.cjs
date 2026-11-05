'use strict';
// Agents acting together: patterns across one customer's agents, read as each request happens.
//   same request   the same request arrives from many different agents inside the window (a swarm, or one bad
//                  instruction copied to every agent). One agent repeating itself is the loop guard's job.
//   split payments money actions across the customer's agents add up past the customer's threshold inside the
//                  window, while each one alone stays under it (the pattern used to slip under an approval limit).
//   fan-out        one agent, or the customer key, hands work to many new agents inside the window.
// Agents are told apart by their handoff key (verified) or, without one, by the x-governance-agent header the
// customer's own code sends (declared, and marked so on the receipt). Every finding is kept for the Console and
// receipted on the request that tripped it. Findings say what pattern, how many agents, which hold or receipt;
// never the prompt or the answer.
const fs = require('fs');
const path = require('path');

const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
// a money amount from a tool call's input: amount, total, value, sum, price (or *_cents, divided by 100)
function amountOf(input) {
  let o = input;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { const m = o.match(/(?:amount|total|value|sum|price)\D{0,6}([\d,]+(?:\.\d+)?)/i); return m ? parseFloat(m[1].replace(/,/g, '')) : null; } }
  let best = null;
  const walk = (x, depth) => {
    if (!x || typeof x !== 'object' || depth > 4) return;
    Object.keys(x).forEach(k => {
      const v = x[k];
      if (v && typeof v === 'object') return walk(v, depth + 1);
      const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*[$€£]?\s*[\d,]+(\.\d+)?\s*$/.test(v) ? parseFloat(v.replace(/[$€£,\s]/g, '')) : NaN;
      if (!Number.isFinite(n) || n <= 0) return;
      if (/cents?$/i.test(k) && /amount|total|value|sum|price|cents/i.test(k)) { if (best == null) best = n / 100; }
      else if (/^(amount|total|value|sum|price|amount_usd|amountusd|usd|payment_amount|refund_amount)$/i.test(k.replace(/[-\s]/g, '_')) || /amount/i.test(k)) { if (best == null) best = n; }
    });
  };
  walk(o, 0);
  return best;
}

function tracker(dataDir) {
  const file = dataDir ? path.join(dataDir, 'gateway-patterns.json') : null;
  let db = { tenants: {} };
  try { if (file && fs.existsSync(file)) db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { db = { tenants: {} }; }
  const save = () => { if (!file) return; try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(db), { mode: 0o600 }); } catch (e) {} };
  const same = new Map(), pays = new Map(), fans = new Map(), told = new Map();
  const trim = (m, k, from) => { const a = (m.get(k) || []).filter(x => x.at > from); m.set(k, a); if (m.size > 50000) m.delete(m.keys().next().value); return a; };
  return {
    amountOf,
    // distinct agents that sent this same request inside the window (this one included)
    same(tenantId, sig, agent, windowSec) {
      const now = Date.now(), k = tenantId + ':' + sig, a = trim(same, k, now - windowSec * 1000);
      a.push({ at: now, agent }); if (a.length > 5000) a.splice(0, a.length - 5000);
      return Array.from(new Set(a.map(x => x.agent)));
    },
    // money actions across all the customer's agents inside the window (these included)
    pay(tenantId, agent, amounts, windowSec) {
      const now = Date.now(), k = tenantId, a = trim(pays, k, now - windowSec * 1000);
      amounts.forEach(v => a.push({ at: now, agent, v }));
      if (a.length > 5000) a.splice(0, a.length - 5000);
      return { total: a.reduce((s, x) => s + x.v, 0), count: a.length, agents: Array.from(new Set(a.map(x => x.agent))), largest: a.reduce((m, x) => Math.max(m, x.v), 0) };
    },
    // new handoffs from one agent (or the customer key) inside the window (this one included)
    fan(tenantId, parent, windowSec) {
      const now = Date.now(), k = tenantId + ':' + parent, a = trim(fans, k, now - windowSec * 1000);
      a.push({ at: now }); return a.length;
    },
    // keep a finding; true the first time this pattern is seen inside its window (alerts go out once per pattern)
    record(tenantId, f, windowSec) {
      const t = db.tenants[tenantId] || (db.tenants[tenantId] = { findings: [] });
      t.findings.push(Object.assign({ at: new Date().toISOString() }, f));
      if (t.findings.length > 300) t.findings.splice(0, t.findings.length - 300);
      save();
      const k = tenantId + ':' + f.kind + ':' + (f.key || ''), now = Date.now(), last = told.get(k);
      if (last && now - last < windowSec * 1000) return false;
      told.set(k, now); if (told.size > 20000) told.delete(told.keys().next().value);
      return true;
    },
    findings(tenantId) { const t = db.tenants[tenantId]; return t ? t.findings.slice(-100).reverse() : []; },
    // secret notes: a coded mark (K7Q2-ZX91-MBR4, a long encoded string) carried by agents that share no handoff.
    // Returns the marks in this request, whether it reads like a note left for others, and the agents in OTHER
    // lineages that carried the same mark inside the window. Marks are kept by fingerprint, never as words.
    covert(tenantId, text, agent, windowSec) {
      const marks = marksOf(text); if (!marks.length) return { marks, note: false, met: [] };
      const now = Date.now(), note = NOTE_WORDS.test(String(text || '')), met = [], seen = new Set();
      marks.forEach(m => {
        const k = tenantId + ':' + fp(m), a = trim(notes, k, now - windowSec * 1000);
        const strong = note || a.some(x => x.note) || m.length >= 24;
        a.filter(x => x.lineage !== agent.lineage).forEach(x => { if (strong && !seen.has(x.key)) { seen.add(x.key); met.push({ key: x.key, name: x.name, at: x.at, mark: m }); } });
        a.push({ at: now, key: agent.key, name: agent.name, lineage: agent.lineage, note }); if (a.length > 200) a.splice(0, a.length - 200);
      });
      return { marks, note, met };
    },
    // who is linked by one secret mark right now (for the Lighthouse): one group per mark, oldest carrier first
    covertGroups(tenantId, windowSec) {
      const now = Date.now(), out = [], pre = tenantId + ':';
      notes.forEach((a, k) => { if (k.indexOf(pre) !== 0) return; const live = a.filter(x => x.at > now - windowSec * 1000), keys = Array.from(new Set(live.map(x => x.key)));
        if (keys.length >= 2 && new Set(live.map(x => x.lineage)).size >= 2) out.push({ mark: k.slice(pre.length), keys, first: live[0].name, at: new Date(live[live.length - 1].at).toISOString() }); });
      return out;
    }
  };
}
const notes = new Map();
// a coded mark: three or more dash-joined groups mixing letters and digits, or a long encoded string (base64 / hex)
const NOTE_WORDS = /\b(notes? for|leave (?:it|this|a note|the note)|left (?:a|the) note|found the note|the note|mailbox|bulletin|board|dead ?drop|secret|hidden|don'?t tell|between us|the others|other agents|pass (?:it|this) on|code ?word|cache|signal)\b/i;
function marksOf(text) {
  const s = String(text || ''), out = new Set();
  (s.match(/\b[A-Za-z0-9]{3,8}(?:-[A-Za-z0-9]{3,8}){2,}\b/g) || []).forEach(m => { if (/[A-Za-z]/.test(m) && /\d/.test(m)) out.add(m.toUpperCase()); });
  (s.match(/[A-Za-z0-9+\/]{24,}={0,2}/g) || []).forEach(m => { if (/[A-Z]/.test(m) && /[a-z]/.test(m) && /\d/.test(m)) out.add(m); });
  (s.match(/\b[0-9a-f]{32,}\b/gi) || []).forEach(m => out.add(m.toLowerCase()));
  return Array.from(out).slice(0, 5);
}
const fp = m => require('crypto').createHash('sha256').update(m).digest('hex').slice(0, 16);
// who is acting: a handoff key is verified; without one, the customer's code may name its agent (declared)
function agentOf(req, handoff) {
  if (handoff) return { key: 'handoff:' + handoff.id, name: handoff.toAgent, verified: true };
  const d = clean(req.headers['x-governance-agent'], 80);
  return d ? { key: 'declared:' + d.toLowerCase(), name: d, verified: false } : { key: 'customer-key', name: 'the customer key', verified: true };
}
module.exports = { tracker, agentOf, amountOf, marksOf };
