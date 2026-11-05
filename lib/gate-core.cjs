'use strict';
// Governed gate pipeline, shared by every gate route.
// Order of operations (fixes from independent review, Oct 29 2026):
//   1. identity      the route refuses unauthenticated callers (401) before this runs; the requester is recorded
//   2. code checks   PII, minors, health data, money approval, injection: no model call
//   3. decision      NO stops here. WAIT opens a hold and stops here unless a person already approved it.
//   4. gate models   crisis consensus and intent classification (counted and receipted)
//   5. target model  the only call that produces the answer
//   6. output checks disclosures and personal identifiers in the answer; a failure withholds the answer
//   7. receipt       every check with its stage and result, the requester, the hold and approval history,
//                    real timings, provider token counts, and the previous receipt's hash in the same chain
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sha = s => crypto.createHash('sha256').update(String(s == null ? '' : s)).digest('hex');
const nowIso = () => new Date().toISOString();
const ms = t0 => Math.round(Number(process.hrtime.bigint() - t0) / 1000) / 1000;

// ---------- code checks (run before any model call) ----------
function luhn(d) { let s = 0, alt = false; for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } s += n; alt = !alt; } return s % 10 === 0; }
function hasCard(t) { const m = String(t).match(/\b(?:\d[ -]?){13,19}\b/g) || []; return m.some(x => { const d = x.replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d); }); }
const SSN = t => /\b\d{3}[-. ]\d{2}[-. ]\d{4}\b/.test(t) || /\b(ssn|ss#|social security( number)?)\b\D{0,25}\d{9}\b/i.test(t);
const ACCOUNT = t => /\b(account|acct|routing|aba|iban|swift|bic|checking|savings)\b(\s*(no\.?|number|#))?\D{0,20}\d{6,}/i.test(t) || /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/.test(t);

const RULES = [
  { id: 'injection', label: 'Instruction override or prompt injection', action: 'NO',
    test: t => /\b(ignore|disregard|forget)\b.{0,30}\b(previous|prior|above|all|your)\b.{0,20}\b(instructions?|rules|prompt)\b|\byou are now\b|\bsystem prompt\b|\bjailbreak\b|\[system\]|\[admin\]|<\/?script/i.test(t) },
  { id: 'ssn', label: 'Social Security number in the request', action: 'WAIT', test: SSN },
  { id: 'payment-card', label: 'Payment card number in the request', action: 'WAIT', test: hasCard },
  { id: 'financial-account', label: 'Bank or financial account number in the request', action: 'WAIT', test: ACCOUNT },
  { id: 'health-data', label: 'Personal health information in the request', action: 'WAIT',
    test: t => /\b(diagnos\w*|prescri\w*|medical record|MRN|HIV|AIDS|cancer|chemotherapy|diabetes|depression|bipolar|schizophren\w*|psychiatric|lab results?|blood (test|work)|medications?|treatment plan|PHI|pregnan\w*|overdose)\b/i.test(t)
      && /\b(patient|my|his|her|their|DOB|date of birth|born|member id|MRN|Mr\.?|Mrs\.?|Ms\.?|named)\b/i.test(t) },
  { id: 'minor', label: 'A specific minor is the subject of the request', action: 'WAIT',
    test: t => /\b([1-9]|1[0-7])[- ]?(year[- ]?old|yr[- ]?old|yo|y\/o)\b/i.test(t) || /\baged? ([1-9]|1[0-7])\b/i.test(t)
      || /\b(my|his|her|their|our|a|the)\s+(son|daughter|child|kid|stepson|stepdaughter|grandson|granddaughter|nephew|niece)\b/i.test(t)
      || /\b(minor|juvenile|underage)\b/i.test(t) || /\b(student|child|kid|boy|girl|foster (child|youth))\s+(named|called)\b/i.test(t) },
  { id: 'money-approval', label: 'Request to approve, move or pay money', action: 'WAIT',
    test: t => /\b(approve|authori[sz]e|release|wire|transfer|send|pay|disburse|refund|reimburse)\b[^.?!\n]{0,60}(\$\s?\d|\b\d[\d,.]*\s?(usd|dollars|k)\b|\bpayment\b|\bfunds\b|\binvoice\b|\bwire\b|\bmoney\b)/i.test(t) }
];
function codeChecks(prompt, harmPatterns) {
  const t0 = process.hrtime.bigint();
  const results = RULES.map(r => ({ id: r.id, stage: 'pre-model (code)', label: r.label, action: r.action, result: r.test(prompt) ? 'fail' : 'pass' }));
  const harmHit = (harmPatterns || []).some(p => p.test(prompt));
  results.push({ id: 'harm-flag', stage: 'pre-model (code)', label: 'Harmful-content pattern (the intent check decides)', action: 'FLAG', result: harmHit ? 'flagged' : 'pass' });
  const fails = results.filter(r => r.result === 'fail');
  const decision = fails.some(r => r.action === 'NO') ? 'NO' : fails.some(r => r.action === 'WAIT') ? 'WAIT' : 'GO';
  return { decision, results, triggered: fails, harmHit, ms: ms(t0) };
}
// The same identifier checks, applied to an answer
function outputIdentifiers(t) { return SSN(t) || hasCard(t) || ACCOUNT(t); }

// ---------- holds and chains (persisted on the data volume when there is one) ----------
function store(dataDir) {
  const file = dataDir ? path.join(dataDir, 'gate-holds.json') : null;
  let db = { holds: {}, chains: {} };
  try { if (file && fs.existsSync(file)) db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.log('[GATE] hold store unreadable, starting empty:', e.message); }
  const save = () => { if (!file) return; try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(db)); } catch (e) { console.log('[GATE] hold store not saved:', e.message); } };
  return {
    getHold: id => db.holds[id] || null,
    putHold: h => { db.holds[h.id] = h; save(); },
    lastHash: chainId => db.chains[chainId] || null,
    setLast: (chainId, h) => { db.chains[chainId] = h; save(); },
    listHolds: () => Object.values(db.holds).sort((a, b) => a.openedAt < b.openedAt ? 1 : -1).slice(0, 100),
    allHolds: () => Object.values(db.holds)
  };
}

// ---------- the pipeline ----------
// deps: { axios, apiKey, model, gateModel, harmPatterns, consensusCrisisCheck, modelEClassify, runOutputChecks, buildSignedReceipt, store }
async function run(deps, { prompt, agentId, requester, holdId, extra }) {
  const tStart = process.hrtime.bigint();
  const promptHash = sha(prompt);
  const S = deps.store;
  const steps = [];
  const step = (status, detail) => steps.push({ status, detail, time: nowIso() });
  let gateIn = 0, gateOut = 0, targetIn = 0, targetOut = 0, modelCalls = 0, gateMs = null, output = null;
  const providerIds = [];
  let hold = null, chainId = 'chain-' + crypto.randomUUID().slice(0, 16);

  const finish = (verdict, released, note, crisis) => {
    if (verdict === 'CERTIFIED' && !(requester && requester.verified)) verdict = 'RELEASED_UNVERIFIED';
    const rec = deps.buildSignedReceipt(Object.assign({}, extra || {}, {
      prompt, agentId, verdict, released, output: released ? output : null,
      checks, requester, chain: { chainId, prevReceiptHash: S.lastHash(chainId) },
      hold: hold ? { id: hold.id, status: hold.status, triggered: hold.triggered, approver: hold.approver || null, decidedAt: hold.decidedAt || null, reason: hold.reason || null, history: hold.history.slice() } : null,
      modelCalls, providerIds,
      tokensInput: gateIn + targetIn, tokensOutput: gateOut + targetOut, gateTokensInput: gateIn, gateTokensOutput: gateOut, targetTokensInput: targetIn, targetTokensOutput: targetOut, tokensGenerated: targetOut,
      gateDurationMs: gateMs != null ? gateMs : ms(tStart), totalDurationMs: ms(tStart), note
    }));
    S.setLast(chainId, rec.receiptHash);
    step(verdict, note + ' Model calls: ' + modelCalls + '.');
    step('RECEIPT', rec.receiptHash.slice(0, 32) + '...');
    return { verdict, released, note, steps, checks, output: released ? output : undefined, hold: hold ? { id: hold.id, status: hold.status } : null, crisis: !!crisis, receiptHash: rec.receiptHash, signedReceipt: rec, modelCalls, chainId };
  };

  // 1. identity is recorded as a check
  let checks = [{ id: 'identity', stage: 'pre-model (auth)', label: 'Requester identity', result: requester && requester.verified ? 'pass' : 'unverified', detail: requester ? requester.label : 'none' }];

  // 2. code checks
  const cc = codeChecks(prompt, deps.harmPatterns);
  checks = checks.concat(cc.results);
  cc.results.forEach(r => { if (r.result !== 'pass') step(r.action === 'NO' ? 'NO' : r.action === 'WAIT' ? 'WAIT' : 'FLAG', r.label); });
  step('CODE CHECKS', cc.results.length + ' checks in ' + cc.ms + ' ms. No model call. Decision: ' + cc.decision + '.');

  if (holdId) {
    const h = S.getHold(holdId);
    if (!h) return finish('NO', false, 'Unknown hold ' + holdId + '. Nothing was sent to a model.');
    if (h.promptHash !== promptHash || !requester || h.requester.id !== requester.id) return finish('NO', false, 'Hold ' + holdId + ' belongs to a different request or requester. Nothing was sent to a model.');
    hold = h; chainId = h.chainId;
  }

  // 3. decision before any model call
  if (cc.decision === 'NO') return finish('NO', false, 'Blocked before any model call: ' + cc.triggered.map(r => r.label).join('; ') + '.');
  const gateHold = (triggered, why) => {
    if (!hold) {
      const id = 'HOLD-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      hold = { id, chainId, promptHash, requester, agentId, openedAt: nowIso(), status: 'pending', triggered: triggered.map(r => ({ id: r.id, label: r.label, result: 'fail' })), history: [] };
      const r = finish('WAIT', false, why + ' Held for a person to review. Hold ' + id + '.');
      hold.history.push({ event: 'WAIT', at: hold.openedAt, receiptHash: r.receiptHash });
      S.putHold(hold);
      r.hold = { id: hold.id, status: hold.status };
      return r;
    }
    if (hold.status === 'pending') return finish('WAIT', false, 'Still waiting for review (hold ' + hold.id + ').');
    if (hold.status === 'denied') return finish('NO', false, 'A person denied this request (hold ' + hold.id + ').');
    if (hold.used) return finish('NO', false, 'The approval on hold ' + hold.id + ' was already used once.');
    // approved: the triggering checks keep their original result, with the approval recorded beside them
    checks = checks.map(c => c.result === 'fail' || c.result === 'flagged' ? Object.assign({}, c, { resolvedBy: 'human approval', approver: hold.approver, approvedAt: hold.decidedAt, approvalReason: hold.reason, holdId: hold.id }) : c);
    step('APPROVED', 'Hold ' + hold.id + ' approved by ' + hold.approver + ' at ' + hold.decidedAt + ': ' + hold.reason);
    return null;
  };
  if (cc.decision === 'WAIT') { const r = gateHold(cc.triggered, 'Stopped before any model call.'); if (r) return r; }

  // 4. gate models, still before the target call
  const cr = await deps.consensusCrisisCheck(prompt);
  gateIn += cr.inputTokens || 0; gateOut += cr.outputTokens || 0;
  const votes = cr.votes || [], failedVotes = votes.filter(v => v.vote === 'ERROR_FAIL_SAFE').length;
  modelCalls += votes.length - failedVotes;   // a call that failed produced nothing and is not counted as a model call
  if (votes.length && failedVotes === votes.length) {
    checks.push({ id: 'crisis-consensus', stage: 'pre-target (gate models)', label: 'Crisis signal, three-model consensus', result: 'unavailable', detail: failedVotes + ' of ' + votes.length + ' gate model calls failed' });
    step('GATE UNAVAILABLE', 'The crisis check could not reach its models (' + failedVotes + ' of ' + votes.length + ' calls failed).');
    return finish('GATE_UNAVAILABLE', false, 'The gate could not reach its models, so it failed closed. Nothing was sent to the target model. Check the provider key and try again.');
  }
  checks.push({ id: 'crisis-consensus', stage: 'pre-target (gate models)', label: 'Crisis signal, three-model consensus', result: cr.crisis ? 'fail' : 'pass', detail: (cr.votes || []).map(v => v.provider + ':' + v.vote).join(', ') });
  step(cr.crisis ? 'CONSENSUS CRISIS' : 'CONSENSUS CLEAR', (cr.votes || []).map(v => v.provider + ':' + v.vote).join(', '));
  if (cr.crisis) return finish('CRISIS_ROUTE', false, 'Routed to crisis resources. The target model was not called.', true);

  const me = await deps.modelEClassify(prompt, deps.apiKey, deps.gateModel || deps.model);
  gateIn += me.inputTokens || 0; gateOut += me.outputTokens || 0; modelCalls += 1;
  checks.push({ id: 'intent', stage: 'pre-target (gate model)', label: 'Intent classification', result: me.conflict ? 'fail' : 'pass', detail: me.category });
  step(me.category, (me.conflict ? '✗ ' : '✓ ') + 'Intent: ' + me.category + '. ' + String(me.detail || '').slice(0, 300));
  if (me.conflict) return finish('WITHHOLD', false, 'Intent classified ' + me.category + '. The target model was not called.');
  // a harmful-content pattern the classifier did not call benign goes to a person before the target call
  if (cc.harmHit && me.category !== 'BENIGN') { const r = gateHold(cc.results.filter(c => c.id === 'harm-flag'), 'Harmful-content pattern with intent ' + me.category + '. The target model was not called.'); if (r) return r; }
  gateMs = ms(tStart);

  // 5. the target call
  const tT = process.hrtime.bigint();
  const api = await deps.axios.post('https://api.anthropic.com/v1/messages', { model: deps.model, max_tokens: 1024, temperature: 0, system: 'You are a governed AI agent. Include governance disclosures.', messages: [{ role: 'user', content: 'GOVERNANCE PROTOCOL: State identity, purpose, data boundaries, governance authority, human review. Then respond to: ' + prompt }] },
    { headers: { 'x-api-key': deps.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 120000 });
  output = (api.data.content || []).map(c => c.text || '').join('');
  const u = api.data.usage || {};
  targetIn = Number(u.input_tokens || 0); targetOut = Number(u.output_tokens || 0); modelCalls += 1;
  providerIds.push({ messageId: api.data.id || null, requestId: (api.headers && api.headers['request-id']) || null });
  if (hold) { hold.used = true; hold.usedAt = nowIso(); S.putHold(hold); }
  step('GENERATED', targetOut + ' output tokens (provider count) in ' + ms(tT) + ' ms.');

  // 6. output checks
  const oc = deps.runOutputChecks(prompt, output);
  oc.results.forEach(r => checks.push(Object.assign({ stage: 'post-target (output)' }, r)));
  oc.results.forEach(r => step(r.result === 'pass' ? 'PASS' : r.result === 'review' ? 'REVIEW' : 'FAIL', (r.result === 'pass' ? '✓ ' : r.result === 'review' ? '⚠ ' : '✗ ') + r.label));
  const released = oc.allPass;
  const verdict = !released ? 'WITHHELD' : oc.minorMention ? 'RELEASED_FOR_REVIEW' : 'CERTIFIED';
  return finish(verdict, released, released ? (verdict === 'CERTIFIED' ? 'All checks passed.' : 'Released and flagged for review: minors are mentioned.') : 'Answer withheld: ' + oc.results.filter(r => r.result === 'fail').map(r => r.label).join('; ') + '. The target model did run and is recorded.');
}

// A person's decision on a hold. The decision receipt continues the same chain.
function decide(deps, holdId, { decision, approver, reason }) {
  const S = deps.store, hold = S.getHold(holdId);
  if (!hold) return { status: 404, body: { error: 'Hold not found' } };
  if (hold.status !== 'pending') return { status: 409, body: { error: 'Hold already ' + hold.status } };
  if (decision !== 'approve' && decision !== 'deny') return { status: 400, body: { error: 'decision must be approve or deny' } };
  if (!approver || !reason) return { status: 400, body: { error: 'approver and reason are required' } };
  hold.status = decision === 'approve' ? 'approved' : 'denied';
  hold.approver = String(approver).slice(0, 120); hold.reason = String(reason).slice(0, 500); hold.decidedAt = nowIso();
  delete hold.sealedPrompt; // the held text is kept only while a reviewer needs it
  const rec = deps.buildSignedReceipt({
    prompt: '', promptHashOverride: hold.promptHash, agentId: hold.agentId, verdict: decision === 'approve' ? 'GO' : 'NO', released: false, output: null,
    checks: hold.triggered.map(r => Object.assign({ stage: 'pre-model (code)' }, r)), requester: hold.requester,
    chain: { chainId: hold.chainId, prevReceiptHash: S.lastHash(hold.chainId) },
    hold: { id: hold.id, status: hold.status, triggered: hold.triggered, approver: hold.approver, decidedAt: hold.decidedAt, reason: hold.reason, history: hold.history.slice() },
    modelCalls: 0, providerIds: [], tokensInput: 0, tokensOutput: 0, tokensGenerated: 0, gateDurationMs: 0, totalDurationMs: 0,
    note: 'Human decision on hold ' + hold.id + '. No model call.'
  });
  hold.history.push({ event: decision === 'approve' ? 'GO' : 'NO', at: hold.decidedAt, by: hold.approver, reason: hold.reason, receiptHash: rec.receiptHash });
  S.putHold(hold); S.setLast(hold.chainId, rec.receiptHash);
  return { status: 200, body: { holdId: hold.id, status: hold.status, receiptHash: rec.receiptHash, signedReceipt: rec } };
}

module.exports = { RULES, codeChecks, outputIdentifiers, store, run, decide, sha };
