'use strict';
const plainTenant = l => { const m = /^Tenant (.+?)(?: \(gateway API key verified\))?$/.exec(String(l || '')); return m ? 'An AI agent using ' + m[1] + '\'s gateway key' : l; };
// THE WHY (James, Nov 4 2026): the Gov5 Gateway shows the reason a decision was made, and Oshi, the Voice of Trust,
// can say it aloud. Same rule as Pocket Oshi: Oshi never invents a reason. Every sentence here is read from the signed
// receipt (its checks, the hold, the person's decision, the agent). Nothing is guessed after the fact.
//
// PCC (Persistent Context Chain) inside every Gateway: when a receipt is made, its explanation is sealed into the
// customer's own chain. Each entry carries the receipt hash, the explanation hash and the previous entry's hash, back to
// a genesis anchored to U.S. Patent Application 19/571,156. One chain per customer; customers never see each other's.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sha = s => crypto.createHash('sha256').update(String(s == null ? '' : s)).digest('hex');
const GENESIS = sha('GENESIS:DeBaccoNexus:Gov5Gateway:PCC:19/571,156');

// ---------- reading a receipt ----------
function payloadOf(rec) {
  if (!rec) return {};
  try { return JSON.parse(rec.payload); } catch (e) { return rec.receipt || {}; }
}
function agentOf(r) {
  const q = r.requester || {};
  const m = String(q.label || '').match(/^Agent (.+?) acting for (.+?) under handoff (\S+)/);
  if (m) return { kind: 'agent', name: m[1], for: m[2], handoff: m[3], key: q.id || m[1] };
  if (q.kind === 'agent') return { kind: 'agent', name: q.label || q.id || 'an agent', key: q.id || q.label };
  return { kind: 'key', name: q.label || 'the customer key', key: q.id || q.label || 'customer' };
}
const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const lower1 = s => s ? s.charAt(0).toLowerCase() + s.slice(1) : s;

// What each decision means, in plain words (7/70)
const HEADLINE = {
  AGENTS_CONTAINED: 'A person stopped one agent and everything it started. The other agents kept working.',
  AGENTS_STOPPED: 'A person revoked the authority of every agent at once.',
  CERTIFIED: 'Passed every check, so the AI was allowed to answer.',
  RELEASED_UNVERIFIED: 'Passed the checks and was answered, but the sender could not be verified.',
  RELEASED_FOR_REVIEW: 'Answered, and flagged for a person to look at.',
  WAIT: 'The brake held this request for a person to decide. No AI answer was made.',
  GO: 'A person reviewed the held request and approved it.',
  NO: 'The brake stopped this request.',
  DENIED: 'The brake stopped this request.',
  WITHHELD: 'The AI answered, but the answer was kept back because it broke a rule.',
  WITHHOLD: 'The gate read the purpose of the request and stopped it before the AI answered.',
  CRISIS_ROUTE: 'The gate heard signs of a crisis and sent the person to help instead of the AI.',
  GATE_UNAVAILABLE: 'The gate could not reach its checking models, so it failed closed. Nothing went through.',
  HANDOFF: 'One agent handed work to another agent, inside the limits it was given.',
  PROVIDER_ERROR: 'The AI provider failed to answer. The failure is on the record.',
  ERROR: 'Something went wrong, so nothing was released. The failure is on the record.',
  GATE_ERROR_PASSTHROUGH: 'The gate had an error and the request was passed through. This is on the record.',
  NO_PROMPT: 'There was nothing to check, so nothing was sent.'
};
const RESULT = { done: 'done', pass: 'passed', fail: 'stopped here', flagged: 'flagged', unavailable: 'could not run', review: 'needs review', unverified: 'not verified' };

function explain(rec, meta) {
  const r = payloadOf(rec);
  const verdict = String(r.verdict || 'UNKNOWN');
  const checks = Array.isArray(r.checks) ? r.checks : [];
  const agent = agentOf(r);
  const modelCalls = Number(r.model_calls || 0);
  const hold = r.hold || null;
  let headline = HEADLINE[verdict] || ('The decision was ' + verdict.toLowerCase().replace(/_/g, ' ') + '.');
  if ((verdict === 'NO' || verdict === 'DENIED') && modelCalls === 0) headline = 'The brake stopped this request before any AI ran.';

  // the logic path: every check, in the order it ran
  const path = checks.map(c => ({
    id: c.id, stage: c.stage || '', label: clean(c.label), result: c.result,
    said: (c.result === 'fail' && (verdict === 'GO' || verdict === 'WAIT')) ? 'held for a person' : (RESULT[c.result] || c.result || ''),
    mark: c.resolvedBy === 'human approval' ? 'ok' : c.result === 'pass' ? 'pass' : c.result === 'fail' ? ((verdict === 'GO' || verdict === 'WAIT') ? 'flag' : 'stop') : 'flag', detail: c.detail ? clean(c.detail).slice(0, 200) : null,
    approvedBy: c.resolvedBy === 'human approval' ? { by: clean(c.approver), reason: clean(c.approvalReason), at: c.approvedAt || null } : null
  }));
  const stopped = path.filter(p => p.result === 'fail' && !p.approvedBy);
  const flagged = path.filter(p => p.result === 'flagged' || p.result === 'review' || p.result === 'unavailable');
  const approved = path.filter(p => p.approvedBy);
  const passed = path.filter(p => p.result === 'pass');

  const reasons = [];
  stopped.forEach(p => reasons.push(p.label + '.'));
  approved.forEach(p => reasons.push(p.label + ' was found, and ' + p.approvedBy.by + ' approved it' + (p.approvedBy.reason ? ': ' + p.approvedBy.reason : '') + '.'));
  flagged.forEach(p => reasons.push(p.label + ': ' + p.said + '.'));

  // the person's decision on a hold
  let person = null;
  if (hold && hold.approver && hold.decidedAt) person = { by: clean(String(hold.approver).replace(/\s*\(reviewer key[^)]*\)\s*$/, '')), decision: hold.status, reason: clean(hold.reason), at: hold.decidedAt };

  const who = agent.kind === 'agent' ? 'AI agent "' + agent.name + '"' + (agent.for ? ', working for ' + agent.for : '') : plainTenant(clean(agent.name));
  const spokenParts = [headline];
  if (agent.kind === 'agent') spokenParts.push('This came from ' + who + '.');
  if (reasons.length) spokenParts.push((verdict === 'GO' ? 'The brake had held it because of this: ' : stopped.length ? 'The reason: ' : 'What the gate found: ') + reasons.join(' '));
  if (person) spokenParts.push('A person, ' + person.by + ', ' + (person.decision === 'approved' ? 'approved' : 'denied') + ' it' + (person.reason ? ', saying: ' + person.reason : '') + '.');
  if (passed.length) spokenParts.push(passed.length + (passed.length === 1 ? ' check' : ' checks') + ' passed.');
  if (modelCalls === 0 && verdict !== 'HANDOFF') spokenParts.push('No AI model ran, so nothing was spent on it.');
  spokenParts.push('This reason comes from the sealed receipt, not from memory.');

  const out = {
    receiptId: meta && meta.id || r.gateway_receipt_id || null, at: r.timestamp || null, verdict, headline, who, agent,
    modelCalls, path, stopped: stopped.map(p => p.label), approved: approved.map(p => p.label), person,
    note: r.note ? clean(r.note) : null, spoken: spokenParts.join(' ')
  };
  out.explanationHash = sha(JSON.stringify({ verdict: out.verdict, headline: out.headline, who: out.who, path: out.path, person: out.person }));
  return out;
}

// ---------- many decisions at once: one agent, one verdict, or everything ----------
function explainMany(rows, opts) {
  opts = opts || {};
  const items = rows.map(row => explain(row.rec, row));
  const by = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
  const verdicts = by(items, x => x.verdict);
  const reasons = {}; items.forEach(x => x.stopped.concat(x.approved).forEach(l => { reasons[l] = (reasons[l] || 0) + 1; }));
  const topReasons = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([label, count]) => ({ label, count }));
  const agents = {}; items.forEach(x => {
    const k = x.agent.kind === 'agent' ? x.agent.name : x.who;
    const a = agents[k] || (agents[k] = { name: k, kind: x.agent.kind, total: 0, passed: 0, braked: 0, held: 0, approved: 0 });
    a.total++;
    if (x.verdict === 'CERTIFIED' || x.verdict === 'RELEASED_UNVERIFIED' || x.verdict === 'RELEASED_FOR_REVIEW') a.passed++;
    if (['NO', 'DENIED', 'WITHHELD', 'WITHHOLD', 'GATE_UNAVAILABLE', 'CRISIS_ROUTE'].includes(x.verdict)) a.braked++;
    if (x.verdict === 'WAIT') a.held++;
    if (x.verdict === 'GO') a.approved++;
  });
  const agentList = Object.values(agents).sort((a, b) => b.total - a.total);
  const n = items.length;
  const braked = items.filter(x => ['NO', 'DENIED', 'WITHHELD', 'WITHHOLD', 'GATE_UNAVAILABLE', 'CRISIS_ROUTE'].includes(x.verdict)).length;
  const held = verdicts.WAIT || 0, passed = (verdicts.CERTIFIED || 0) + (verdicts.RELEASED_UNVERIFIED || 0) + (verdicts.RELEASED_FOR_REVIEW || 0);
  const brakeBeforeModel = items.filter(x => x.modelCalls === 0 && ['NO', 'DENIED', 'WAIT'].includes(x.verdict)).length;
  const s = [];
  if (!n) s.push('There are no decisions to explain yet.');
  else {
    s.push((opts.scope ? opts.scope + ': ' : '') + n + (n === 1 ? ' decision.' : ' decisions.'));
    const nn = (k, one, many) => k + ' ' + (k === 1 ? one : many);
    s.push(nn(passed, 'passed', 'passed') + ' every check. ' + nn(held, 'was', 'were') + ' held for a person. ' + nn(braked, 'was', 'were') + ' stopped by the brake.');
    const approvedN = verdicts.GO || 0; if (approvedN) s.push(nn(approvedN, 'was', 'were') + ' approved by a person after a hold.');
    if (brakeBeforeModel) s.push((brakeBeforeModel === held + braked ? (brakeBeforeModel === 1 ? 'That one was' : brakeBeforeModel === 2 ? 'Both were' : 'All ' + brakeBeforeModel + ' were') : nn(brakeBeforeModel, 'was', 'were')) + ' stopped or held before any AI ran, so nothing was spent on ' + (brakeBeforeModel === 1 ? 'it.' : 'them.'));
    if (topReasons.length) s.push(topReasons[0].count > 1 ? 'The most common reason, ' + topReasons[0].count + ' times: ' + topReasons[0].label + '.' : 'The reasons: ' + topReasons.slice(0, 4).map(r => r.label).join('; ') + '.');
    if (agentList.length > 1) {
      const worst = agentList.slice().sort((a, b) => (b.braked + b.held) - (a.braked + a.held))[0];
      if (worst && worst.braked + worst.held > 0) s.push(worst.name + ' was stopped or held most often, ' + (worst.braked + worst.held) + ' of ' + worst.total + ' times.');
    }
    s.push('Every reason comes from the sealed receipts, not from memory.');
  }
  return { count: n, verdicts, passed, held, braked, brakeBeforeModel, topReasons, agents: agentList, spoken: s.join(' '), items: items.slice(0, 50) };
}

// ---------- PCC: the sealed chain of explanations, one per customer ----------
function pcc(dataDir) {
  const file = dataDir ? path.join(dataDir, 'gateway-pcc.jsonl') : null;
  const heads = {}, mem = [];
  const load = () => {
    if (!file || !fs.existsSync(file)) return mem.slice();
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  };
  // an index, so finding a receipt's entry never rereads the whole chain
  const byReceipt = new Map(), spoken = [];
  load().forEach(e => { heads[e.tenantId] = { seq: e.seq, hash: e.hash }; if (e.receiptId) byReceipt.set(e.receiptId, e); if (e.verdict === 'OSHI_SPOKE') { spoken.push(e); if (spoken.length > 2000) spoken.shift(); } });
  const append = entry => {
    if (file) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 }); } catch (e) { console.log('[PCC] not saved:', e.message); } }
    else { mem.push(entry); if (mem.length > 5000) mem.shift(); }
  };
  const link = (tenantId, receiptId, receiptHash, explanationHash, verdict, extra) => {
    const prev = heads[tenantId] || { seq: 0, hash: GENESIS };
    const entry = Object.assign({ tenantId, seq: prev.seq + 1, at: new Date().toISOString(), receiptId, receiptHash, explanationHash, verdict, prev: prev.hash }, extra || {});
    entry.hash = sha([entry.tenantId, entry.seq, entry.at, entry.receiptId, entry.receiptHash, entry.explanationHash, entry.verdict, entry.prev].join('|'));
    heads[tenantId] = { seq: entry.seq, hash: entry.hash }; if (receiptId) byReceipt.set(receiptId, entry);
    append(entry); return entry;
  };
  return {
    // what Oshi said out loud, sealed in the same chain: the words are hashed into the link, so they can never be changed later
    say(tenantId, kind, ref, text, audioHash) {
      const t = String(text || '').slice(0, 2000);
      const e = link(tenantId, 'spoken:' + kind + ':' + String(ref || '').slice(0, 80), audioHash || null, sha('oshi-spoke|' + t), 'OSHI_SPOKE', { kind, text: t });
      spoken.push(e); if (spoken.length > 2000) spoken.shift(); return e;
    },
    spoken(tenantId, n) { return spoken.filter(e => !tenantId || e.tenantId === tenantId).slice(-(n || 50)).reverse(); },
    textMatches(e) { return !!e && e.verdict === 'OSHI_SPOKE' && sha('oshi-spoke|' + (e.text || '')) === e.explanationHash; },
    seal(tenantId, receiptId, rec) {
      const ex = explain(rec, { id: receiptId });
      return link(tenantId, receiptId, rec && rec.receiptHash || null, ex.explanationHash, ex.verdict);
    },
    entryFor(receiptId) { return byReceipt.get(receiptId) || null; },
    // walk one customer's chain from genesis: every link must hold
    verify(tenantId) {
      const list = load().filter(e => e.tenantId === tenantId);
      let prev = GENESIS, seq = 0;
      for (const e of list) {
        const h = sha([e.tenantId, e.seq, e.at, e.receiptId, e.receiptHash, e.explanationHash, e.verdict, e.prev].join('|'));
        if (e.prev !== prev || e.seq !== seq + 1 || h !== e.hash) return { ok: false, length: list.length, brokenAt: e.seq };
        prev = e.hash; seq = e.seq;
      }
      return { ok: true, length: list.length, head: prev };
    },
    genesis: GENESIS
  };
}

module.exports = { explain, explainMany, pcc, payloadOf, GENESIS };
