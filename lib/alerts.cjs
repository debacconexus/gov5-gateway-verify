'use strict';
// Alerts: tell a person the moment the gateway needs one.
//   what fires    the event itself, never a timer: a hold opened (a person must approve), a request refused, a spending
//                 alert or cap reached. Each is sent once, as it happens.
//   where to      per customer, up to five channels: Slack or Microsoft Teams incoming webhooks, or any HTTPS webhook
//                 (JSON, signed with HMAC-SHA256 in x-governance-signature so the receiver can prove it came from us).
//   what it says  what happened, which agent, the hold or receipt id and a link to the Console. Never the prompt, the
//                 answer or any customer data: the reviewer reads those in the Console after signing in.
//   safety        HTTPS only; private and local network addresses are never contacted; webhook addresses are stored
//                 encrypted and shown only as a hint; at most 30 alerts per customer in 10 minutes, the rest are counted
//                 and reported in the next alert, so a runaway agent cannot flood a channel.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const SC = require('./source-check.cjs');

const EVENTS = { hold: 'A person must approve something', blocked: 'A request was refused', spend: 'Spending alert or cap reached', coordinated: 'Agents acting together' };
const KINDS = ['slack', 'teams', 'webhook', 'call'];
const E164 = /^\+[1-9][0-9]{7,14}$/;
const MAX_CHANNELS = 5, BURST = 30, BURST_WINDOW_MS = 10 * 60 * 1000;

function makeCode(code, ownerIn) {
  code = String(code || '').trim();
  if (!/^[0-9]{4,8}$/.test(code)) return { error: 'The PIN must be 4 to 8 digits.' };
  if (/^(\d)\1+$/.test(code) || '0123456789'.indexOf(code) > -1 || '9876543210'.indexOf(code) > -1) return { error: 'Choose a PIN that is harder to guess than repeated or counting digits.' };
  const owner = String(ownerIn || '').trim().slice(0, 80); if (!owner) return { error: 'Enter the name of the person who answers this phone, so their decisions are recorded under their name.' };
  const codeSalt = crypto.randomBytes(16).toString('hex');
  return { codeHash: crypto.scryptSync(code, codeSalt, 32).toString('hex'), codeSalt, owner };
}
function store(dataDir, seal, unseal) {
  let caller = null; // set by the gateway: Oshi's phone call (lib/oshi-call.cjs)
  const file = dataDir ? path.join(dataDir, 'gateway-alerts.json') : null;
  let db = { tenants: {} };
  try { if (file && fs.existsSync(file)) db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { db = { tenants: {} }; }
  const save = () => { if (!file) return; try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(db), { mode: 0o600 }); } catch (e) {} };
  const T = id => db.tenants[id] || (db.tenants[id] = { channels: [], log: [], sent: [], suppressed: 0, spendSent: {}, secret: crypto.randomBytes(24).toString('hex') });
  const hint = u => { try { const x = new URL(u); return x.host + (x.pathname.length > 1 ? x.pathname.slice(0, 12) + '…' : ''); } catch (e) { return '…'; } };
  const pub = (id, full) => { const t = T(id); return { channels: t.channels.map(c => ({ id: c.id, kind: c.kind, hint: c.hint, events: c.events, addedAt: c.addedAt, addedBy: c.addedBy })), log: t.log.slice(-50).reverse(), events: EVENTS, secret: full ? t.secret : null }; };

  async function safeUrl(u) {
    let x; try { x = new URL(String(u || '').trim()); } catch (e) { return 'That is not a web address.'; }
    // tests only: GATEWAY_ALERT_ALLOW_PRIVATE=1 lets a local receiver on http stand in for Slack
    if (process.env.GATEWAY_ALERT_ALLOW_PRIVATE === '1') return /^https?:$/.test(x.protocol) ? null : 'Use an https:// address.';
    if (x.protocol !== 'https:') return 'Use an https:// address.';
    try { const a = await dns.lookup(x.hostname, { all: true }); if (!a.length || a.some(r => SC.isPrivate(r.address))) return 'Private and local network addresses are not allowed.'; }
    catch (e) { return 'That address could not be found.'; }
    return null;
  }
  function text(ev) {
    const lines = [ev.why ? 'Gov5 Gateway voice receipt: ' + ev.title : ev.title];
    if (ev.why) lines.push('Why: ' + ev.why);
    if (ev.detail) lines.push(ev.detail);
    if (ev.agent) lines.push('Agent: ' + ev.agent);
    if (ev.ref) lines.push(ev.ref);
    if (ev.link) lines.push((ev.why && ev.event !== 'hold' ? 'Hear Oshi explain it: ' : ev.event === 'hold' ? 'Review and decide in the Console: ' : 'Open the Console: ') + ev.link);
    if (ev.suppressed) lines.push(ev.suppressed + ' more alert' + (ev.suppressed === 1 ? ' was' : 's were') + ' held back in the last 10 minutes to avoid flooding.');
    return lines.join('\n');
  }
  function bodyFor(kind, ev, tenantId) {
    if (kind === 'slack' || kind === 'teams') return { text: text(ev) };
    return { event: ev.event, tenant: tenantId, title: ev.title, detail: ev.detail || null, agent: ev.agent || null, holdId: ev.holdId || null, receiptId: ev.receiptId || null, why: ev.why || null, voice: ev.why ? 'Oshi' : null, link: ev.link || null, at: ev.at, suppressedSinceLast: ev.suppressed || 0 };
  }
  async function deliver(axios, tenantId, ch, ev) {
    let url; try { url = unseal(ch.sealedUrl); } catch (e) { return { ok: false, status: 'unreadable' }; }
    if (ch.kind === 'call') return caller ? caller(url, Object.assign({ tenantName: ev.tenantName }, ev), { tenantId, channelId: ch.id, owner: ch.owner || null, hasCode: !!ch.codeHash }) : { ok: false, status: 'Phone calls are not available.' };
    const bad = await safeUrl(url); if (bad) return { ok: false, status: bad };
    const payload = JSON.stringify(bodyFor(ch.kind, ev, tenantId)), headers = { 'content-type': 'application/json', 'user-agent': 'DeBacco-Nexus-Governed-Gateway/1.0 (alerts)' };
    if (ch.kind === 'webhook') headers['x-governance-signature'] = 'sha256=' + crypto.createHmac('sha256', T(tenantId).secret).update(payload).digest('hex');
    const once = () => axios.post(url, payload, { headers, timeout: 5000, maxRedirects: 0, validateStatus: () => true }).then(r => ({ ok: r.status < 300, status: r.status })).catch(e => ({ ok: false, status: e.code || 'error' }));
    let r = await once();
    if (!r.ok && (typeof r.status !== 'number' || r.status >= 500 || r.status === 429)) { await new Promise(z => setTimeout(z, 1500)); r = await once(); }
    return r;
  }
  return {
    EVENTS, pub, setCaller(fn) { caller = fn; },
    // add or change the approval code on a phone channel already in place (we fix, we do not remove)
    setCode(tenantId, channelId, code, owner, by) {
      const t = T(tenantId), ch = t.channels.find(c => c.id === channelId);
      if (!ch || ch.kind !== 'call') return { error: 'Phone channel not found.' };
      const k = makeCode(code, owner); if (k.error) return k;
      Object.assign(ch, k, { fails: [] }); ch.hint = ch.hint.split(' \u00b7 ')[0] + ' \u00b7 ' + k.owner + ', PIN set';
      t.log.push({ at: new Date().toISOString(), event: 'setup', channel: ch.id, ok: true, status: 'PIN set for ' + k.owner + ' by ' + String(by || '').slice(0, 120) }); save();
      return { ok: true, hint: ch.hint };
    },
    // check a reviewer's approval code for one phone channel; five wrong codes in an hour lock that phone out of approving
    verifyCode(tenantId, channelId, code) {
      const t = T(tenantId), ch = t.channels.find(c => c.id === channelId); if (!ch || !ch.codeHash) return { ok: false, reason: 'nocode' };
      const now = Date.now(); ch.fails = (ch.fails || []).filter(x => now - x < 3600000);
      if (ch.fails.length >= 5) { save(); return { ok: false, reason: 'locked' }; }
      const got = crypto.scryptSync(String(code || ''), ch.codeSalt, 32), want = Buffer.from(ch.codeHash, 'hex');
      const ok = got.length === want.length && crypto.timingSafeEqual(got, want);
      if (!ok) ch.fails.push(now); else ch.fails = [];
      t.log.push({ at: new Date(now).toISOString(), event: 'setup', channel: ch.id, ok, status: ok ? 'PIN verified by phone' : 'Wrong PIN entered by phone' }); save();
      return { ok, reason: ok ? null : (ch.fails.length >= 5 ? 'locked' : 'wrong'), owner: ch.owner };
    },
    async addChannel(tenantId, spec, by) {
      spec = spec || {}; const t = T(tenantId);
      if (t.channels.length >= MAX_CHANNELS) return { error: 'Up to ' + MAX_CHANNELS + ' alert channels per customer.' };
      const kind = KINDS.includes(spec.kind) ? spec.kind : null; if (!kind) return { error: 'Choose Slack, Teams, webhook or phone call.' };
      let codeHash = null, codeSalt = null, owner = null;
      if (kind === 'call') { spec.url = String(spec.url || spec.phone || '').replace(/[\s().-]/g, ''); if (/^[0-9]{10}$/.test(spec.url)) spec.url = '+1' + spec.url; if (!E164.test(spec.url)) return { error: 'Enter the phone number with its country code, for example +1 310 555 0100.' };
        const code = String(spec.code || '').trim();
        if (code) { const k = makeCode(code, spec.owner); if (k.error) return k; ({ codeHash, codeSalt, owner } = k); } }
      else { const bad = await safeUrl(spec.url); if (bad) return { error: bad }; }
      const events = (Array.isArray(spec.events) ? spec.events : Object.keys(EVENTS)).filter(e => e in EVENTS);
      if (!events.length) return { error: 'Choose at least one event.' };
      const ch = { id: 'al_' + crypto.randomBytes(5).toString('hex'), kind, sealedUrl: seal(String(spec.url).trim()), hint: kind === 'call' ? 'phone ending ' + String(spec.url).slice(-4) + (codeHash ? ' \u00b7 ' + owner + ', PIN set' : '') : hint(spec.url), events, codeHash, codeSalt, owner, addedAt: new Date().toISOString(), addedBy: String(by || '').slice(0, 120) };
      t.channels.push(ch); t.log.push({ at: ch.addedAt, event: 'setup', channel: ch.id, ok: true, status: 'Channel added by ' + ch.addedBy }); save();
      return { channel: pub(tenantId).channels.find(c => c.id === ch.id) };
    },
    removeChannel(tenantId, id, by) {
      const t = T(tenantId), n = t.channels.length; t.channels = t.channels.filter(c => c.id !== id);
      if (t.channels.length === n) return false;
      t.log.push({ at: new Date().toISOString(), event: 'setup', channel: id, ok: true, status: 'Channel removed by ' + String(by || '').slice(0, 120) }); save(); return true;
    },
    // demo: copy a customer's phone-call channel (number, owner, PIN hash) to the demo customer, holds only, one call per live run
    copyCallChannel(fromTenantId, toTenantId, by) {
      const src = T(fromTenantId).channels.find(c => c.kind === 'call' && c.codeHash); if (!src) return null;
      const t = T(toTenantId); t.channels = t.channels.filter(c => !c.demoCopy);
      const ch = Object.assign({}, src, { id: 'al_' + crypto.randomBytes(5).toString('hex'), events: ['hold'], demoCopy: true, once: true, onceUsed: false, addedAt: new Date().toISOString(), addedBy: String(by || '').slice(0, 120) });
      t.channels.push(ch); t.log.push({ at: ch.addedAt, event: 'setup', channel: ch.id, ok: true, status: 'Phone call copied for the live demo by ' + ch.addedBy }); save();
      return { hint: ch.hint, owner: ch.owner };
    },
    armOnce(tenantId) { T(tenantId).channels.forEach(c => { if (c.once) c.onceUsed = false; }); save(); },
    // send one event to every channel that wants it; never throws, never blocks the request that caused it
    emit(axios, tenantId, ev) {
      const t = T(tenantId), now = Date.now();
      ev = Object.assign({ at: new Date(now).toISOString() }, ev);
      const targets = t.channels.filter(c => (c.events.includes(ev.event) || ev.event === 'test') && !(c.once && c.onceUsed));
      targets.forEach(c => { if (c.once) c.onceUsed = true; });
      if (!targets.length) return Promise.resolve([]);
      if (ev.event !== 'test') {
        t.sent = t.sent.filter(x => now - x < BURST_WINDOW_MS);
        if (t.sent.length >= BURST) { t.suppressed++; save(); return Promise.resolve([]); }
        t.sent.push(now);
      }
      ev.suppressed = t.suppressed; t.suppressed = 0;
      return Promise.all(targets.map(ch => deliver(axios, tenantId, ch, ev).then(r => {
        t.log.push({ at: ev.at, event: ev.event, channel: ch.id, kind: ch.kind, ok: r.ok, status: r.status, ref: ev.holdId || ev.receiptId || null });
        if (t.log.length > 300) t.log.splice(0, t.log.length - 300);
        save(); return r;
      }))).catch(() => []);
    },
    // spending alerts go out once per level per day (daily cap) or per month (monthly cap)
    spendOnce(tenantId, key) { const t = T(tenantId); if (t.spendSent[key]) return false; t.spendSent[key] = new Date().toISOString(); const ks = Object.keys(t.spendSent); if (ks.length > 100) ks.slice(0, ks.length - 100).forEach(k => delete t.spendSent[k]); save(); return true; }
  };
}
module.exports = { store, EVENTS };
