'use strict';
// Spend and action guard for the Gov5 Gateway.
//   spending caps   per customer, per UTC day and month, in USD at the provider's list price. At 80% the Console and every
//                   response carry an alert; at 100%, or when a request's worst case would cross the cap, the request is held
//                   for a person or refused (the customer chooses). The provider's invoice is the authority; this is the guard.
//   loop detection  the same request (same newest user message and model) repeated past a limit inside a window is held or
//                   refused. While one such hold is waiting, further copies are refused so a runaway cannot flood reviewers.
//   answer size     an optional per-request cap on output tokens; a larger request is lowered to the cap and the receipt says so.
//   money actions   when the AI's answer calls a tool that moves money or sets a price, the answer is held before it reaches
//                   the customer's systems. After approval the same answer (not a new one) is released once.
const fs = require('fs');
const path = require('path');

// USD per million tokens, list prices. Unknown models are priced at the most expensive tier of their provider so caps err safe.
const PRICES = [
  [/opus-5/i, 4, 20], [/sonnet-5/i, 2, 10], [/haiku/i, 1, 5], [/opus/i, 5, 25], [/sonnet|claude/i, 3, 15],
  [/gpt-4o-mini/i, 0.15, 0.6], [/gpt-4\.1-nano/i, 0.1, 0.4], [/gpt-4\.1-mini/i, 0.4, 1.6], [/gpt-4\.1/i, 2, 8], [/gpt-4o/i, 2.5, 10],
  [/gpt-5-nano/i, 0.05, 0.4], [/gpt-5-mini/i, 0.25, 2], [/gpt-5/i, 1.25, 10], [/o4-mini|o3-mini/i, 1.1, 4.4], [/\bo3\b/i, 2, 8], [/\bo1\b/i, 15, 60]
];
const FALLBACK = { anthropic: [5, 25], openai: [15, 60] };
function priceOf(model, provider) {
  const m = String(model || '');
  for (const p of PRICES) if (p[0].test(m)) return { input: p[1], output: p[2], known: true };
  const f = FALLBACK[provider] || FALLBACK.openai; return { input: f[0], output: f[1], known: false };
}
const costUSD = (model, provider, input, output) => { const p = priceOf(model, provider); return (Number(input || 0) * p.input + Number(output || 0) * p.output) / 1e6; };
// ---------- the provider's discount on text the AI has already read (prompt caching) ----------
//   Anthropic: text marked for reuse costs 1.25x to store once and 0.1x each time it is read again. The gateway marks
//   long, repeated text (a large system prompt or tool list, and multi-turn conversations) when the customer has not.
//   OpenAI caches on its own; its discount is measured and shown, never credited to the gateway.
const READ_RATE = { anthropic: 0.1 }, WRITE_RATE = { anthropic: 1.25 };
const openaiCachedRate = m => /gpt-5|gpt-4\.1|o4|o3/i.test(String(m || '')) ? (/gpt-5/i.test(String(m)) ? 0.1 : 0.25) : 0.5;
// actual cost with cached reads and writes; input is the total input tokens including cached ones
function costWithCache(model, provider, input, output, cacheRead, cacheWrite) {
  const p = priceOf(model, provider), r = Number(cacheRead || 0), w = Number(cacheWrite || 0), base = Math.max(0, Number(input || 0) - r - w);
  const rr = provider === 'openai' ? openaiCachedRate(model) : READ_RATE.anthropic, wr = provider === 'openai' ? 1 : WRITE_RATE.anthropic;
  return (base * p.input + w * p.input * wr + r * p.input * rr + Number(output || 0) * p.output) / 1e6;
}
// what caching saved against the same request without it (negative while the first copy is being stored)
function cacheSavedUSD(model, provider, input, output, cacheRead, cacheWrite) {
  return costUSD(model, provider, input, output) - costWithCache(model, provider, input, output, cacheRead, cacheWrite);
}
const LONG = 4000; // characters, about 1,000 tokens: below the providers' minimum nothing is cached and nothing is charged extra
const len = x => { try { return typeof x === 'string' ? x.length : JSON.stringify(x || '').length; } catch (e) { return 0; } };
const mark = block => { block.cache_control = { type: 'ephemeral' }; };
// marks reusable text in an Anthropic request; returns what was marked, or null when the customer already manages caching
function addPromptCache(body) {
  if (!body || !Array.isArray(body.messages)) return null;
  if (/"cache_control"/.test(JSON.stringify(body))) return null;
  const marks = [];
  if (typeof body.system === 'string' && body.system.length >= LONG) { body.system = [{ type: 'text', text: body.system }]; }
  if (Array.isArray(body.system) && body.system.length && len(body.system) >= LONG) { mark(body.system[body.system.length - 1]); marks.push('system'); }
  else if (Array.isArray(body.tools) && body.tools.length && len(body.tools) >= LONG) { mark(body.tools[body.tools.length - 1]); marks.push('tools'); }
  const msgs = body.messages, last = msgs[msgs.length - 1];
  if (msgs.length >= 3 && len(msgs) >= LONG && last) {
    if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
    const blocks = Array.isArray(last.content) ? last.content.filter(b => b && b.type !== 'thinking' && b.type !== 'redacted_thinking') : [];
    if (blocks.length) { mark(blocks[blocks.length - 1]); marks.push('conversation'); }
  }
  return marks.length ? marks : null;
}

const DEFAULTS = { dailyUsd: null, monthlyUsd: null, atLimit: 'WAIT', alertPct: 80, loopRepeats: 60, loopWindowSec: 60, loopAction: 'WAIT', maxOutputTokens: null, moneyActions: 'WAIT', moneyTools: [], manualCheckMin: null, holdReviewMin: null, staffHourlyUsd: null, promptCache: 'AUTO', sourceCheck: 'FLAG', hiddenInstructions: 'WAIT', allowedTools: [], toolAction: 'WAIT', handoffAction: 'NO', coordAgents: 5, coordWindowSec: 60, coordAction: 'FLAG', splitUsd: null, splitAction: 'WAIT', fanOut: 10, fanOutAction: 'FLAG', dormantHours: 24, dormantAction: 'WAIT', orphanAction: 'FLAG', criticalContain: 'RECOMMEND', watchDelegation: 'ALLOW', driftAction: 'WAIT', covertAction: 'WAIT', covertWindowSec: 3600, trustCalls: 50, trustDays: 7, watchDays: 30 };
const ACTIONS = ['WAIT', 'NO'];
const num = (v, min, max) => { if (v === null || v === '' || v === undefined) return null; const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : undefined; };
function limitsOf(t) {
  const l = Object.assign({}, DEFAULTS, (t && t.limits) || {});
  l.moneyTools = Array.isArray(l.moneyTools) ? l.moneyTools : [];
  l.allowedTools = Array.isArray(l.allowedTools) ? l.allowedTools : [];
  return l;
}
// validate a change set from the Console; returns { limits, errors }
function cleanLimits(cur, changes) {
  const out = Object.assign({}, cur), errors = [];
  const set = (k, v) => { if (v === undefined) errors.push(k); else out[k] = v; };
  const c = changes || {};
  if ('dailyUsd' in c) set('dailyUsd', num(c.dailyUsd, 0.01, 1e7));
  if ('monthlyUsd' in c) set('monthlyUsd', num(c.monthlyUsd, 0.01, 1e8));
  if ('atLimit' in c) set('atLimit', ACTIONS.includes(c.atLimit) ? c.atLimit : undefined);
  if ('loopRepeats' in c) set('loopRepeats', c.loopRepeats === null || c.loopRepeats === '' ? null : num(c.loopRepeats, 2, 10000));
  if ('loopWindowSec' in c) { const v = num(c.loopWindowSec, 5, 3600); set('loopWindowSec', v === null ? 60 : v); }
  if ('loopAction' in c) set('loopAction', ACTIONS.includes(c.loopAction) ? c.loopAction : undefined);
  if ('maxOutputTokens' in c) set('maxOutputTokens', num(c.maxOutputTokens, 1, 1e6) == null ? num(c.maxOutputTokens, 1, 1e6) : Math.floor(c.maxOutputTokens));
  // the customer's own staff-time numbers, used only for the savings view
  if ('manualCheckMin' in c) set('manualCheckMin', num(c.manualCheckMin, 0.1, 600));
  if ('holdReviewMin' in c) set('holdReviewMin', num(c.holdReviewMin, 0.1, 600));
  if ('staffHourlyUsd' in c) set('staffHourlyUsd', num(c.staffHourlyUsd, 1, 10000));
  if ('hiddenInstructions' in c) set('hiddenInstructions', ['WAIT', 'NO', 'FLAG', 'OFF'].includes(c.hiddenInstructions) ? c.hiddenInstructions : undefined);
  // agent passes: what earns trust, and how long a mark counts against it
  if ('trustCalls' in c) { const v = num(c.trustCalls, 1, 1e6); set('trustCalls', v === null ? 50 : v); }
  if ('trustDays' in c) { const v = num(c.trustDays, 0, 3650); set('trustDays', v === null ? 7 : v); }
  if ('watchDays' in c) { const v = num(c.watchDays, 1, 3650); set('watchDays', v === null ? 30 : v); }
  // agents acting together
  if ('coordAgents' in c) set('coordAgents', c.coordAgents === null || c.coordAgents === '' ? null : num(c.coordAgents, 2, 10000));
  if ('coordWindowSec' in c) { const v = num(c.coordWindowSec, 5, 86400); set('coordWindowSec', v === null ? 60 : v); }
  if ('coordAction' in c) set('coordAction', ['FLAG', 'WAIT', 'NO'].includes(c.coordAction) ? c.coordAction : undefined);
  if ('splitUsd' in c) set('splitUsd', num(c.splitUsd, 0.01, 1e9));
  if ('splitAction' in c) set('splitAction', ['FLAG', 'WAIT', 'NO'].includes(c.splitAction) ? c.splitAction : undefined);
  if ('fanOut' in c) set('fanOut', c.fanOut === null || c.fanOut === '' ? null : num(c.fanOut, 2, 10000));
  // agent charters: a sleeping agent that wakes up, and actions with no living person behind them
  if ('dormantHours' in c) set('dormantHours', c.dormantHours === null || c.dormantHours === '' ? null : num(c.dormantHours, 0.0005, 8760));
  if ('dormantAction' in c) set('dormantAction', ['FLAG', 'WAIT', 'NO'].includes(c.dormantAction) ? c.dormantAction : undefined);
  // containment policy: on a critical refusal (hidden instructions), recommend to a person or quarantine the lineage at once
  if ('criticalContain' in c) set('criticalContain', ['RECOMMEND', 'AUTO'].includes(c.criticalContain) ? c.criticalContain : undefined);
  // an agent on watch may keep handing out work, or loses that right until a person restores it
  if ('watchDelegation' in c) set('watchDelegation', ['ALLOW', 'NO'].includes(c.watchDelegation) ? c.watchDelegation : undefined);
  // secret notes between agents that share no handoff: held for a person (WAIT), refused (NO) or recorded (FLAG)
  if ('covertAction' in c) set('covertAction', ['FLAG', 'WAIT', 'NO'].includes(c.covertAction) ? c.covertAction : undefined);
  if ('covertWindowSec' in c) { const v = num(c.covertWindowSec, 60, 86400); set('covertWindowSec', v === null ? 3600 : v); }
  if ('driftAction' in c) set('driftAction', ['FLAG', 'WAIT', 'NO'].includes(c.driftAction) ? c.driftAction : undefined);
  if ('orphanAction' in c) set('orphanAction', ['FLAG', 'WAIT', 'NO'].includes(c.orphanAction) ? c.orphanAction : undefined);
  if ('fanOutAction' in c) set('fanOutAction', ['FLAG', 'NO'].includes(c.fanOutAction) ? c.fanOutAction : undefined);
  if ('handoffAction' in c) set('handoffAction', ACTIONS.includes(c.handoffAction) ? c.handoffAction : undefined);
  if ('toolAction' in c) set('toolAction', ACTIONS.includes(c.toolAction) ? c.toolAction : undefined);
  if ('allowedTools' in c) {
    const list = (Array.isArray(c.allowedTools) ? c.allowedTools : String(c.allowedTools || '').split(/[\s,]+/)).map(s => String(s).trim()).filter(s => /^[A-Za-z0-9_.:\/-]{1,128}$/.test(s));
    set('allowedTools', Array.from(new Set(list)).slice(0, 200));
  }
  if ('sourceCheck' in c) set('sourceCheck', ['FLAG', 'WAIT', 'OFF'].includes(c.sourceCheck) ? c.sourceCheck : undefined);
  if ('promptCache' in c) set('promptCache', ['AUTO', 'OFF'].includes(c.promptCache) ? c.promptCache : undefined);
  if ('moneyActions' in c) set('moneyActions', ['WAIT', 'OFF'].includes(c.moneyActions) ? c.moneyActions : undefined);
  if ('moneyTools' in c) {
    const list = (Array.isArray(c.moneyTools) ? c.moneyTools : String(c.moneyTools || '').split(/[\s,]+/)).map(s => String(s).trim()).filter(s => /^[A-Za-z0-9_.:-]{1,64}$/.test(s));
    set('moneyTools', Array.from(new Set(list)).slice(0, 50));
  }
  return { limits: out, errors };
}

// ---------- spend ledger (UTC day and month), kept in gateway-spend.json ----------
const dayKey = d => d.toISOString().slice(0, 10), monthKey = d => d.toISOString().slice(0, 7);
function ledger(dataDir) {
  const file = dataDir ? path.join(dataDir, 'gateway-spend.json') : null;
  let db = {}; try { if (file && fs.existsSync(file)) db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { db = {}; }
  let timer = null;
  const save = () => { if (!file || timer) return; timer = setTimeout(() => { timer = null; try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(db)); } catch (e) {} }, 500); if (timer.unref) timer.unref(); };
  const row = id => {
    const now = new Date(), d = dayKey(now), m = monthKey(now);
    const r = db[id] = db[id] || { day: d, dayUsd: 0, month: m, monthUsd: 0, calls: 0 };
    if (r.day !== d) { r.day = d; r.dayUsd = 0; r.dayAlert = false; }
    if (r.month !== m) { r.month = m; r.monthUsd = 0; r.monthAlert = false; }
    return r;
  };
  return {
    get(id) { const r = row(id); return { day: r.day, dayUsd: +r.dayUsd.toFixed(6), month: r.month, monthUsd: +r.monthUsd.toFixed(6), calls: r.calls }; },
    add(id, usd) { const r = row(id); r.dayUsd += usd; r.monthUsd += usd; r.calls++; save(); return this.get(id); },
    flush() { if (!file) return; try { fs.writeFileSync(file, JSON.stringify(db)); } catch (e) {} }
  };
}
function spendStatus(l, s) {
  const pct = (used, cap) => cap ? Math.round(used / cap * 1000) / 10 : null;
  const dPct = pct(s.dayUsd, l.dailyUsd), mPct = pct(s.monthUsd, l.monthlyUsd);
  const top = Math.max(dPct || 0, mPct || 0);
  return { dayUsd: s.dayUsd, monthUsd: s.monthUsd, dailyUsd: l.dailyUsd, monthlyUsd: l.monthlyUsd, dayPct: dPct, monthPct: mPct, topPct: (dPct == null && mPct == null) ? null : top,
    alert: top >= (l.alertPct || 80), over: top >= 100 };
}

// worst case for one request: input estimated from its size (about 4 characters a token), output at the requested maximum
function estimateTokens(body) {
  let chars = 0; try { chars = JSON.stringify((body && (body.messages || [])) || []).length + JSON.stringify(body && body.system || '').length + JSON.stringify(body && body.tools || '').length; } catch (e) {}
  const out = Number(body && (body.max_tokens || body.max_completion_tokens || body.max_output_tokens)) || 4096;
  return { input: Math.ceil(chars / 4), output: out };
}

// ---------- the pre-model limit checks; returns check rows in the same shape as the gate's ----------
function preChecks(ctx) {
  const { tenant, provider, body, limits: l, spend, loop } = ctx, rows = [], stage = 'pre-model (limits)';
  // answer size
  if (l.maxOutputTokens) {
    const key = provider === 'openai' ? (body.max_completion_tokens != null ? 'max_completion_tokens' : 'max_tokens') : 'max_tokens';
    const asked = body[key] == null ? null : Number(body[key]);
    if (asked == null || asked > l.maxOutputTokens) { body[key] = l.maxOutputTokens; rows.push({ id: 'answer-size', stage, label: 'Answer size cap', result: 'pass', detail: 'Answer limited to ' + l.maxOutputTokens + ' tokens' + (asked == null ? ' (none was set).' : ' (asked for ' + asked + ').'), adjusted: true }); }
    else rows.push({ id: 'answer-size', stage, label: 'Answer size cap', result: 'pass', detail: 'Asked for ' + asked + ' tokens, within the cap of ' + l.maxOutputTokens + '.' });
  }
  // spending caps
  if (l.dailyUsd || l.monthlyUsd) {
    const est = estimateTokens(body), worst = costUSD(body.model, provider, est.input, est.output), st = spendStatus(l, spend);
    const crossDay = l.dailyUsd && spend.dayUsd + worst > l.dailyUsd, crossMonth = l.monthlyUsd && spend.monthUsd + worst > l.monthlyUsd;
    const used = [l.dailyUsd ? 'today $' + spend.dayUsd.toFixed(2) + ' of $' + l.dailyUsd.toFixed(2) : null, l.monthlyUsd ? 'this month $' + spend.monthUsd.toFixed(2) + ' of $' + l.monthlyUsd.toFixed(2) : null].filter(Boolean).join('; ');
    if (st.over || crossDay || crossMonth) rows.push({ id: 'spend-cap', stage, label: 'Spending cap reached', result: 'fail', action: l.atLimit,
      detail: (st.over ? 'The cap is reached: ' : 'This request could cross the cap (worst case $' + worst.toFixed(4) + '): ') + used + '.' });
    else rows.push({ id: 'spend-cap', stage, label: 'Spending cap', result: 'pass', detail: used + (st.alert ? '. Alert: ' + st.topPct + '% of the cap is used.' : '.'), alert: st.alert || undefined });
  }
  // loop detection
  if (l.loopRepeats && loop) {
    if (loop.count > l.loopRepeats) rows.push({ id: 'loop-guard', stage, label: 'Repeated request (possible runaway loop)', result: 'fail', action: loop.pendingHold ? 'NO' : l.loopAction,
      detail: 'The same request arrived ' + loop.count + ' times in ' + l.loopWindowSec + ' seconds (limit ' + l.loopRepeats + ')' + (loop.pendingHold ? '; hold ' + loop.pendingHold + ' for it is already waiting.' : '.') });
  }
  return rows;
}
// counts identical requests per customer inside the window
function loopTracker() {
  const seen = new Map(), pending = new Map();
  return {
    hit(tenantId, key, windowSec) {
      const k = tenantId + ':' + key, now = Date.now(), from = now - windowSec * 1000;
      const a = (seen.get(k) || []).filter(x => x > from); a.push(now); seen.set(k, a.slice(-20000));
      if (seen.size > 50000) seen.delete(seen.keys().next().value);
      return a.length;
    },
    pendingHold(tenantId, key) { return pending.get(tenantId + ':' + key) || null; },
    setPending(tenantId, key, holdId) { pending.set(tenantId + ':' + key, holdId); },
    clear(tenantId, key) { pending.delete(tenantId + ':' + key); }
  };
}

// ---------- money actions in the AI's answer ----------
const MONEY = /\b(pay|pays|paying|payment|payments|payout|payouts|wire|wires|refund\w*|reimburs\w*|charge|charges|invoice\w*|bill|bills|billing|purchase\w*|checkout|withdraw\w*|deposit\w*|disburse\w*|remit\w*|price|prices|pricing|reprice|discount\w*|coupon\w*|rebate\w*|credit|credits|debit|debits|ledger|subscription\w*|fund|funds|money|cash|ach|swift|iban|stripe|paypal|venmo|zelle)\b/i;
const READ_ONLY = /^(get|list|lookup|look up|search|read|fetch|check|view|find|query|show|describe|estimate|quote|calculate|compare)\b/i;
const words = n => String(n || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.:]+/g, ' ').trim();
const isMoneyName = n => { const w = words(n); return MONEY.test(w) && !READ_ONLY.test(w); };
// which declared tools move money or set prices: by name or description, plus any the customer named
function moneyToolNames(body, extra) {
  const names = new Set((extra || []).map(String));
  (Array.isArray(body && body.tools) ? body.tools : []).forEach(t => {
    const f = t && (t.function || t), name = f && f.name, desc = String(f && f.description || '');
    if (!name || READ_ONLY.test(words(name))) return;
    if (isMoneyName(name) || (MONEY.test(desc) && /\b(send|sends|move|moves|set|sets|change|changes|update|updates|approve|approves|issue|issues|apply|applies|charge|charges|pay|pays|refund|refunds|transfer|transfers)\b/i.test(desc))) names.add(name);
  });
  return names;
}
// tool calls in a full (non-streamed) answer
function toolCalls(provider, d) {
  if (!d || typeof d !== 'object') return [];
  if (provider === 'anthropic') return (d.content || []).filter(b => b && b.type === 'tool_use').map(b => ({ name: b.name, input: b.input }));
  const m = (d.choices || [])[0] && d.choices[0].message || {};
  const calls = (m.tool_calls || []).map(c => ({ name: c.function && c.function.name, input: c.function && c.function.arguments }));
  if (m.function_call) calls.push({ name: m.function_call.name, input: m.function_call.arguments });
  return calls;
}
// tool calls rebuilt from a streamed answer (raw SSE text)
function streamToolCalls(provider, raw) {
  const calls = {}; const order = [];
  String(raw || '').split('\n').forEach(l => {
    if (!l.startsWith('data: ') || l.trim() === 'data: [DONE]') return;
    let e; try { e = JSON.parse(l.slice(6)); } catch (x) { return; }
    if (provider === 'anthropic') {
      if (e.type === 'content_block_start' && e.content_block && e.content_block.type === 'tool_use') { calls[e.index] = { name: e.content_block.name, input: '' }; order.push(e.index); }
      else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'input_json_delta' && calls[e.index]) calls[e.index].input += e.delta.partial_json || '';
    } else {
      const c = (e.choices || [])[0]; const tc = c && c.delta && c.delta.tool_calls;
      (tc || []).forEach(t => { const i = t.index || 0; if (!calls[i]) { calls[i] = { name: '', input: '' }; order.push(i); } if (t.function && t.function.name) calls[i].name += t.function.name; if (t.function && t.function.arguments) calls[i].input += t.function.arguments; });
    }
  });
  return order.map(i => calls[i]);
}
function moneyCalls(calls, names) { return calls.filter(c => c && c.name && (names.has(c.name) || isMoneyName(c.name))); }

module.exports = { priceOf, costUSD, costWithCache, cacheSavedUSD, addPromptCache, DEFAULTS, limitsOf, cleanLimits, ledger, spendStatus, estimateTokens, preChecks, loopTracker, moneyToolNames, toolCalls, streamToolCalls, moneyCalls };
