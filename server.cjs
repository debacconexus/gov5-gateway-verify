'use strict';
// Gov5 Gateway, published so anyone can verify or try to disprove it. This file is the Gateway's whole server:
// signed receipts (Ed25519), the Gateway (a drop-in for the Anthropic Messages API) and its Console.
// Nothing here calls a model unless you give a customer a real provider key; the tests and the demo use stand-ins.
require('dotenv').config();
var express = require('express');
var axios = require('axios');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var app = express();
// === SIGNED RECEIPTS ===
// The signing key comes only from the environment (RECEIPT_SIGNING_KEY_PEM). Without one, this run makes its own
// fresh key: its receipts verify against /api/receipt/public-key for as long as it runs, and no key is ever stored here.
var receiptPrivateKey, receiptPublicKey, receiptPublicKeyPem;
try {
  if (process.env.RECEIPT_SIGNING_KEY_PEM) {
    receiptPrivateKey = crypto.createPrivateKey(process.env.RECEIPT_SIGNING_KEY_PEM.replace(/\\n/g, '\n'));
    console.log('[RECEIPTS] Ed25519 signing key loaded from the environment.');
  } else {
    receiptPrivateKey = crypto.generateKeyPairSync('ed25519').privateKey;
    console.log('[RECEIPTS] No RECEIPT_SIGNING_KEY_PEM set: made a fresh signing key for this run only.');
  }
  receiptPublicKey = crypto.createPublicKey(receiptPrivateKey);
  receiptPublicKeyPem = receiptPublicKey.export({ type: 'spki', format: 'pem' });
} catch (e) { console.error('[RECEIPTS] The signing key could not be loaded:', e.message); }

var ECOS_STD = require('./lib/ecos-standard.cjs');
function buildSignedReceipt(fields) {
  var inputTokens = Number.isFinite(Number(fields.tokensInput)) ? Number(fields.tokensInput) : null;
  var outputTokens = Number.isFinite(Number(fields.tokensOutput)) ? Number(fields.tokensOutput) : Number(fields.tokensGenerated || 0);
  var totalTokens = inputTokens == null ? outputTokens : inputTokens + outputTokens;
  var savedTokens = Number.isFinite(Number(fields.tokensSaved)) ? Number(fields.tokensSaved) : 0;
  var lowJoulePerToken = 0.39, highJoulePerToken = 1.8;
  var co2GramsPerJoule = 0.417 * 1000 / 3600000;
  var waterMlPerJoule = 1800 / 3600000;
  // ECOS: the one environmental block every receipt carries (ECOS-2026.4, same standard as Oshi)
  var ecosStages = fields.ecosStages || ((Number(fields.modelCalls) > 0 || (fields.modelCalls == null && totalTokens > 0))
    ? [{ stage: fields.gateTokensInput != null ? 'all model calls (gate and target, counted at the target model tier)' : 'model', model: fields.model || process.env.OSHI_V5_MODEL || 'sonnet', input: inputTokens || 0, output: outputTokens || 0, calls: Number(fields.modelCalls) > 0 ? Number(fields.modelCalls) : 1 }]
    : []);
  var ecos = ECOS_STD.compute(ecosStages, fields.ecosRegion);
  var energyLow = ecos.governed.energy_j;
  var energyHigh = ecos.governed.energy_j;
  var savedEnergyLow = +(savedTokens * lowJoulePerToken).toFixed(4);
  var savedEnergyHigh = +(savedTokens * highJoulePerToken).toFixed(4);
  var canonical = {
    version: 'TRACE-1.1',
    agentId: fields.agentId || 'unknown',
    requester: fields.requester || null,
    prompt_hash: fields.promptHashOverride || crypto.createHash('sha256').update(fields.prompt || '').digest('hex'),
    output_hash: fields.output ? crypto.createHash('sha256').update(fields.output).digest('hex') : null,
    verdict: fields.verdict || 'UNKNOWN',
    released: !!fields.released,
    consensus: fields.consensus || null,
    intent_category: fields.intentCategory || null,
    compliance_pass: fields.compliancePass != null ? fields.compliancePass : null,
    checks_run: fields.checks ? fields.checks.length : (fields.checksRun || 0),
    checks_failed: fields.checks ? fields.checks.filter(function(c){ return c.result === 'fail'; }).map(function(c){ return c.id; }) : (fields.checksFailed || []),
    checks: fields.checks || null,
    hold: fields.hold || null,
    chain: fields.chain || null,
    model_calls: Number.isFinite(Number(fields.modelCalls)) ? Number(fields.modelCalls) : null,
    provider_ids: fields.providerIds || null,
    tokens_input: inputTokens,
    tokens_output: outputTokens,
    tokens_total: totalTokens,
    token_accounting: fields.tokenAccounting || (inputTokens == null ? 'output_word_estimate' : 'provider_usage'),
    gate_tokens_input: Number.isFinite(Number(fields.gateTokensInput)) ? Number(fields.gateTokensInput) : null,
    gate_tokens_output: Number.isFinite(Number(fields.gateTokensOutput)) ? Number(fields.gateTokensOutput) : null,
    target_tokens_input: Number.isFinite(Number(fields.targetTokensInput)) ? Number(fields.targetTokensInput) : null,
    target_tokens_output: Number.isFinite(Number(fields.targetTokensOutput)) ? Number(fields.targetTokensOutput) : null,
    tokens_generated: Number.isFinite(Number(fields.tokensGenerated)) ? Number(fields.tokensGenerated) : outputTokens,
    tokens_saved: savedTokens,
    tokens_saved_basis: savedTokens ? (fields.tokensSavedBasis || 'not measured') : null,
    energy_consumed_joules_low: energyLow,
    energy_consumed_joules_high: energyHigh,
    energy_saved_joules_low: savedEnergyLow,
    energy_saved_joules_high: savedEnergyHigh,
    co2_consumed_grams_low: ecos.governed.co2_g,
    co2_consumed_grams_high: ecos.governed.co2_g,
    water_consumed_ml_low: ecos.governed.water_ml,
    water_consumed_ml_high: ecos.governed.water_ml,
    co2_avoided_grams_low: +(savedEnergyLow * co2GramsPerJoule).toFixed(8),
    co2_avoided_grams_high: +(savedEnergyHigh * co2GramsPerJoule).toFixed(8),
    water_avoided_ml_low: +(savedEnergyLow * waterMlPerJoule).toFixed(8),
    water_avoided_ml_high: +(savedEnergyHigh * waterMlPerJoule).toFixed(8),
    environmental_method: ecos.standard,
    energy_source: 'Jegham et al. 2025 (per input token, output token and call; Haiku 0.1x, Opus 4x Sonnet); grid ' + ecos.region.name + '; water LBNL 2024',
    ecos: ecos,
    timestamp: new Date().toISOString(),
    gate_duration_ms: Number.isFinite(Number(fields.gateDurationMs)) ? Number(fields.gateDurationMs) : null,
    total_duration_ms: Number.isFinite(Number(fields.totalDurationMs)) ? Number(fields.totalDurationMs) : null,
    note: fields.note || null,
    model: fields.model || null,
    gateway_receipt_id: fields.gatewayReceiptId || null,
    evidence_chain: fields.evidenceChain || { status: 'NOT_EVALUATED', reason: 'No evidence artifact was supplied to this transaction.' }
  };
  var payload = JSON.stringify(canonical, null, 0);
  var receiptHash = crypto.createHash('sha256').update(payload).digest('hex');
  var signature = null;
  if (receiptPrivateKey) {
    signature = crypto.sign(null, Buffer.from(payload), receiptPrivateKey).toString('base64');
  }
  return {
    receipt: canonical,
    receiptHash: receiptHash,
    signature: signature,
    publicKey: receiptPublicKeyPem || null,
    payload: payload
  };
}

app.get('/api/receipt/public-key', function(req, res) {
  if (!receiptPublicKeyPem) return res.status(503).json({ error: 'Signing keys not loaded' });
  res.type('text/plain').send(receiptPublicKeyPem);
});


// === END TRACE RECEIPT INFRASTRUCTURE ===

var port = Number(process.env.PORT || 8080);
app.disable('x-powered-by');
// Governed AI gateway (drop-in for the Anthropic Messages API). Registered before the small default body
// parser because real requests carry documents. Shares the gate's hold store, so the same reviewers decide.
var gateCore = require('./lib/gate-core.cjs');
var GATE_STORE = gateCore.store(process.env.OSHI_V5_DATA_DIR || null);
require('./lib/gateway.cjs').register(app, { express: express, axios: axios, gateCore: gateCore, store: GATE_STORE, buildSignedReceipt: buildSignedReceipt, publicKey: function() { return receiptPublicKeyPem; }, dataDir: process.env.OSHI_V5_DATA_DIR || null });

app.use(express.json({ limit: '128kb' }));

app.post('/api/receipt/verify', function(req, res) {
  var body = req.body;
  if (!body || !body.payload || !body.signature) return res.status(400).json({ error: 'Missing payload or signature' });
  if (!receiptPublicKey) return res.status(503).json({ error: 'Verification keys not loaded' });
  try {
    var valid = crypto.verify(null, Buffer.from(body.payload), receiptPublicKey, Buffer.from(body.signature, 'base64'));
    var hash = crypto.createHash('sha256').update(body.payload).digest('hex');
    res.json({ verified: valid, receiptHash: hash, timestamp: new Date().toISOString() });
  } catch(e) {
    res.json({ verified: false, error: e.message });
  }
});
// === HOLD REVIEWER ROUTES ===
// A held request waits for a person. The reviewer key (OSHI_REVIEWER_KEY) decides it; the decision gets its own
// signed receipt that continues the request's chain.
function safeEq(a, b) { a = Buffer.from(String(a || '')); b = Buffer.from(String(b || '')); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function reviewerOk(req) { return !!process.env.OSHI_REVIEWER_KEY && safeEq(req.headers['x-reviewer-key'], process.env.OSHI_REVIEWER_KEY); }
function gateDeps() { return { axios: axios, apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.OSHI_V5_MODEL || 'claude-opus-4-6', buildSignedReceipt: buildSignedReceipt, store: GATE_STORE,
  runOutputChecks: function() { return { results: [], allPass: true, minorMention: false }; } }; }
app.get('/api/gate/holds', function(req, res) {
  if (!reviewerOk(req)) return res.status(401).json({ error: 'Reviewer key required.' });
  res.json({ holds: GATE_STORE.listHolds().map(function(h) { return { id: h.id, status: h.status, openedAt: h.openedAt, requester: h.requester, triggered: h.triggered, approver: h.approver || null, decidedAt: h.decidedAt || null }; }) });
});
app.get('/api/gate/holds/:id', function(req, res) {
  var h = GATE_STORE.getHold(String(req.params.id || ''));
  res.set('Cache-Control', 'no-store').json(h ? { id: h.id, status: h.status, decidedAt: h.decidedAt || null } : { id: req.params.id, status: 'not found' });
});
app.post('/api/gate/holds/:id/decide', function(req, res) {
  if (!reviewerOk(req)) return res.status(401).json({ error: 'Reviewer key required.' });
  var b = req.body || {};
  var r = gateCore.decide(gateDeps(), String(req.params.id || ''), { decision: b.decision, approver: b.approver, reason: b.reason });
  res.status(r.status).json(r.body);
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', function(_req, res) { res.redirect('/console'); });
app.get('/healthz', function(_req, res) { res.status(200).json({ service: 'gov5-gateway', status: 'ok' }); });
app.listen(port, function() { console.log('[GOV5 GATEWAY] listening on port ' + port + '. Console: http://127.0.0.1:' + port + '/console'); });
