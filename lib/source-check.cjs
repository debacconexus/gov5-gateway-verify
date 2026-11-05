'use strict';
// Source check: is the AI's answer backed by the material it was given?
//   numbers     every number in the answer is matched against the numbers in the request (system, user turns, documents,
//               tool results). Small counting numbers (0 to 10 with no %, $ or decimal) are skipped.
//   quotes      text in quotation marks must appear word for word in the material.
//   names       runs of two or more capitalised words (people, brands, places) must appear in the material.
//   references  links and DOIs in the answer are checked to exist. A link that already appears in the material counts as
//               confirmed. Private and local network addresses are never contacted.
// It checks the answer against its sources. It does not decide whether a source is true, or whether a real reference
// says what the answer claims; the receipt says so.
const dns = require('dns').promises;
const net = require('net');

const norm = s => String(s || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
function textOf(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map(b => !b ? '' : typeof b === 'string' ? b : b.type === 'text' ? b.text : b.type === 'tool_result' ? textOf(b.content) : b.type === 'document' && b.source && typeof b.source.data === 'string' && b.source.type === 'text' ? b.source.data : '').filter(Boolean).join('\n');
}
// the material the AI was given: system text and every non-assistant turn (earlier AI answers are not sources)
function sourceText(body) {
  const parts = [];
  if (body && body.system) parts.push(textOf(body.system));
  (Array.isArray(body && body.messages) ? body.messages : []).forEach(m => { if (m && m.role !== 'assistant') parts.push(textOf(m.content)); });
  return parts.join('\n');
}

const NUM = /(?<![\w.])[$€£]?\d{1,3}(?:,\d{3})+(?:\.\d+)?%?(?![\w])|(?<![\w.,])[$€£]?\d+(?:\.\d+)?%?(?![\w])/g;
function numbers(t) {
  const out = [];
  String(t || '').replace(NUM, m => {
    const pct = m.endsWith('%'), cur = /^[$€£]/.test(m), raw = m.replace(/[$€£,%]/g, ''), v = parseFloat(raw);
    if (!Number.isFinite(v)) return m;
    const trivial = !pct && !cur && !/\./.test(raw) && v <= 10;
    out.push({ text: m, value: String(v), trivial });
    return m;
  });
  return out;
}
const QUOTE = /["“]([^"“”\n]{12,300})["”]/g;
const NAME = /\b(?:[A-Z][a-zA-Z'\-]+)(?:\s+(?:(?:of|de|la|van|von)\s+)?[A-Z][a-zA-Z'\-]+)+\b/g;
const SKIP_NAMES = /^(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December|The|This|That|These|Those|In|On|At|For|And|But|If|When|Here|There|We|You|It|I|A|An)\s*)+$/;
const URL_RE = /https?:\/\/[^\s<>"'\])}]+/g;
const DOI_RE = /\b10\.\d{4,9}\/[^\s<>"'\])}]+/g;
const trimP = s => s.replace(/[.,;:!?]+$/, '');

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('::ffff:') && isPrivate(x.slice(7));
}
// confirmed | not-found | unchecked
async function exists(axios, url, opt) {
  let u; try { u = new URL(url); } catch (e) { return 'unchecked'; }
  if (!/^https?:$/.test(u.protocol)) return 'unchecked';
  if (!opt.allowPrivate) {
    try { const addrs = await dns.lookup(u.hostname, { all: true }); if (!addrs.length || addrs.some(a => isPrivate(a.address))) return 'unchecked'; } catch (e) { return opt.resolver ? 'unchecked' : e && e.code === 'ENOTFOUND' ? 'not-found' : 'unchecked'; }
  }
  const go = method => axios.request({ method, url: u.toString(), timeout: opt.timeoutMs || 3000, maxRedirects: 5, validateStatus: () => true, responseType: 'stream', headers: { 'user-agent': 'DeBacco-Nexus-Governed-Gateway/1.0 (reference check)' } })
    .then(r => { try { r.data && r.data.destroy && r.data.destroy(); } catch (e) {} return r.status; });
  try {
    let st = await go('HEAD');
    if (st === 405 || st === 501 || st === 403) st = await go('GET');
    return st < 400 ? 'confirmed' : (st === 404 || st === 410) ? 'not-found' : 'unchecked';
  } catch (e) { return !opt.resolver && e && e.code === 'ENOTFOUND' ? 'not-found' : 'unchecked'; }
}

// answer: the AI's text; body: the request it answered. Returns the receipt check row (without the action).
async function check(answer, body, opt) {
  opt = opt || {};
  const src = sourceText(body), srcN = norm(src), out = String(answer || ''), outPlain = out.replace(URL_RE, ' ').replace(DOI_RE, ' ');
  const srcVals = new Set(numbers(src).map(n => n.value));
  const nums = numbers(outPlain).filter(n => !n.trivial), seen = new Set();
  const numRows = nums.filter(n => { const k = n.text; if (seen.has(k)) return false; seen.add(k); return true; });
  const numMissing = numRows.filter(n => !srcVals.has(n.value)).map(n => n.text);
  const quotes = Array.from(new Set((out.match(QUOTE) || []).map(q => q.slice(1, -1))));
  const quoteMissing = quotes.filter(q => srcN.indexOf(norm(q)) === -1);
  const names = Array.from(new Set((outPlain.match(NAME) || []).map(s => s.trim()).filter(s => !SKIP_NAMES.test(s))));
  const nameMissing = names.filter(n => srcN.indexOf(norm(n)) === -1);
  const refs = Array.from(new Set((out.match(URL_RE) || []).map(trimP))).slice(0, 10).map(u => ({ ref: u, url: u, resolver: false }))
    .concat(Array.from(new Set((out.match(DOI_RE) || []).map(trimP))).filter(d => !(out.match(URL_RE) || []).some(u => u.indexOf(d) > -1)).slice(0, 10).map(d => ({ ref: 'doi:' + d, url: (opt.doiResolver || 'https://doi.org/') + d, resolver: true })));
  const srcLow = src.toLowerCase();
  const refRes = await Promise.all(refs.map(async r => ({ ref: r.ref, status: srcLow.indexOf(r.ref.replace(/^doi:/, '').toLowerCase()) > -1 ? 'confirmed' : opt.checkReferences === false ? 'unchecked' : await exists(opt.axios, r.url, Object.assign({}, opt, { resolver: r.resolver })) })));
  const refMissing = refRes.filter(r => r.status === 'not-found').map(r => r.ref), refUnchecked = refRes.filter(r => r.status === 'unchecked').map(r => r.ref);
  const failed = numMissing.length + quoteMissing.length + refMissing.length;   // names are reported, not failed: a name can be general knowledge
  const part = (n, label, miss) => n ? n + ' ' + label + (n === 1 ? '' : 's') + ', ' + (n - miss) + ' found in the sources' : null;
  const detail = [part(numRows.length, 'number', numMissing.length), part(quotes.length, 'quote', quoteMissing.length), part(names.length, 'name', nameMissing.length),
    refRes.length ? refRes.length + ' reference' + (refRes.length === 1 ? '' : 's') + ', ' + (refRes.length - refMissing.length - refUnchecked.length) + ' confirmed to exist' + (refUnchecked.length ? ', ' + refUnchecked.length + ' could not be checked' : '') : null]
    .filter(Boolean).join('. ') || 'No numbers, quotes, names or references to check.';
  const cap = a => a.slice(0, 10).map(x => String(x).slice(0, 160));
  return {
    id: 'source-check', stage: 'post-model (answer)', label: 'Source check: numbers, quotes, names and references against the material given',
    result: failed ? 'fail' : 'pass', detail: detail + '.' + (failed ? ' Not found: ' + cap(numMissing.concat(quoteMissing.map(q => '"' + q + '"'), refMissing)).join('; ') + '.' : '') + ' Checks the answer against its sources, not whether a source is true.',
    numbers: { total: numRows.length, notFound: cap(numMissing) }, quotes: { total: quotes.length, notFound: cap(quoteMissing) },
    names: { total: names.length, notInSources: cap(nameMissing) }, references: { total: refRes.length, notFound: cap(refMissing), unchecked: cap(refUnchecked) },
    failedItems: failed
  };
}
module.exports = { check, sourceText, numbers, isPrivate };
