'use strict';
// Trojan-horse guard: what the AI reads, and which tools it may use.
//   hidden instructions   documents, tool results, web pages and earlier turns the AI is about to read are searched for
//                         orders aimed at the AI (ignore your rules, new instructions, do not tell the user, fake system
//                         tags) and for invisible characters used to hide text from people. The newest user message is
//                         already checked by the gate's own rules.
//   approved tools        when a customer lists the tools its agents may use, any other tool or tool server in a request
//                         is stopped before the model sees it.
// It finds the known shapes of hidden instructions; it cannot promise to find every one. The money and private-data
// holds stand behind it either way.
const ORDERS = [
  { id: 'override', why: 'tells the AI to ignore its instructions', re: /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|the|any)\b[^.\n]{0,25}\b(instructions?|rules|prompts?|guidelines|directions|policies)\b/i },
  { id: 'new-orders', why: 'gives the AI new instructions', re: /\b(new|updated|real|actual|secret|hidden)\s+(instructions?|orders|directives|task)\b\s*(:|for (the )?(ai|assistant|model|agent|llm))/i },
  { id: 'addressed', why: 'speaks to the AI directly with commands', re: /\b(attention|note to|message to|instructions? (for|to))\s+(the\s+)?(ai|assistant|model|agent|llm|chatbot)\b|\b(dear|hey|hello)\s+(ai|assistant|claude|chatgpt|gpt|gemini|agent)\b[^.\n]{0,60}\b(must|should|need to|please)\b/i },
  { id: 'conceal', why: 'tells the AI to hide something from people', re: /\b(do not|don't|never|without)\s+(tell|telling|inform|informing|mention|mentioning|reveal|revealing|alert|alerting|notify|notifying)\b[^.\n]{0,30}\b(the\s+)?(user|human|client|operator|reviewer|anyone)\b/i },
  { id: 'fake-system', why: 'pretends to be a system or admin message', re: /<\/?\s*(system|instructions?|admin|developer)\s*>|\[\s*(system|admin|instructions?|developer)\s*\]|^\s*(system|admin|developer)\s*(prompt|message|override)?\s*:/im },
  { id: 'role-switch', why: 'tries to change who the AI is', re: /\b(you are now|from now on,? you|act as|pretend (to be|you are)|your new role)\b[^.\n]{0,60}\b(no (rules|limits|restrictions)|unrestricted|without (rules|limits|restrictions)|admin|developer mode|jailbr\w*)/i }
];
// characters that hide text from a person but not from the AI
function invisible(t) {
  const tags = (t.match(/[\u{E0000}-\u{E007F}]/gu) || []).length;
  const bidi = (t.match(/[‪-‮⁦-⁩]/g) || []).length;
  const zwRuns = (t.match(/[​‌‍⁠﻿]{3,}/g) || []).length;
  return { tags, bidi, zwRuns, any: tags > 0 || bidi > 0 || zwRuns > 0 };
}
const txt = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => !b ? '' : typeof b === 'string' ? b : b.type === 'text' ? b.text : b.type === 'tool_result' ? txt(b.content) : b.type === 'document' && b.source && b.source.type === 'text' ? b.source.data : '').filter(Boolean).join('\n') : '';
// everything the AI will read besides the newest user message and the customer's own system prompt
function readMaterial(body) {
  const out = [], msgs = Array.isArray(body && body.messages) ? body.messages : [];
  let lastUser = -1; for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i] && msgs[i].role === 'user') { lastUser = i; break; }
  msgs.forEach((m, i) => {
    if (!m) return;
    if (m.role === 'tool' || m.role === 'function') return out.push({ where: 'tool result', text: txt(m.content) });
    if (Array.isArray(m.content)) m.content.forEach(b => {
      if (!b) return;
      if (b.type === 'tool_result') out.push({ where: 'tool result', text: txt(b.content) });
      else if (b.type === 'document') out.push({ where: 'document', text: txt([b]) });
      else if (b.type === 'text' && m.role === 'user' && i !== lastUser) out.push({ where: 'earlier message', text: b.text });
    });
    else if (m.role === 'user' && i !== lastUser) out.push({ where: 'earlier message', text: txt(m.content) });
  });
  // the newest user turn can carry documents and tool results too; its plain text is already checked by the gate
  return out.filter(x => x.text);
}
function scan(body) {
  const found = [];
  readMaterial(body).forEach(m => {
    ORDERS.forEach(o => { const hit = o.re.exec(m.text); if (hit) found.push({ where: m.where, kind: o.id, why: o.why, sample: hit[0].slice(0, 120) }); });
    const iv = invisible(m.text);
    if (iv.any) found.push({ where: m.where, kind: 'invisible-text', why: 'hides text from people with invisible characters', sample: [iv.tags ? iv.tags + ' hidden tag characters' : null, iv.bidi ? iv.bidi + ' direction-flip characters' : null, iv.zwRuns ? iv.zwRuns + ' runs of zero-width characters' : null].filter(Boolean).join(', ') });
  });
  return found;
}
// tools and tool servers the request offers the AI, by name
function toolsInRequest(body) {
  const names = [];
  (Array.isArray(body && body.tools) ? body.tools : []).forEach(t => { const f = t && (t.function || t); if (f && f.name) names.push(f.name); else if (t && t.type) names.push(t.type); });
  (Array.isArray(body && body.mcp_servers) ? body.mcp_servers : []).forEach(s => { if (s && (s.name || s.url)) names.push('mcp:' + (s.name || s.url)); });
  return names;
}
function preChecks(body, limits) {
  const rows = [], stage = 'pre-model (content)';
  if (limits.hiddenInstructions !== 'OFF') {
    const f = scan(body);
    if (f.length) rows.push({ id: 'hidden-instructions', stage, label: 'Hidden instructions in what the AI is reading', result: 'fail', action: limits.hiddenInstructions,
      detail: f.slice(0, 5).map(x => 'A ' + x.where + ' ' + x.why + ' ("' + x.sample.replace(/[\u{E0000}-\u{E007F}‪-‮⁦-⁩​-‍⁠﻿]/gu, '') + '")').join('; ') + '.', findings: f.slice(0, 10) });
    else if (readMaterial(body).length) rows.push({ id: 'hidden-instructions', stage, label: 'Hidden instructions in what the AI is reading', result: 'pass', detail: 'Documents, tool results and earlier messages searched; no known hidden-instruction patterns found.' });
  }
  const allow = Array.isArray(limits.allowedTools) ? limits.allowedTools : [];
  if (allow.length) {
    const offered = toolsInRequest(body), extra = offered.filter(n => allow.indexOf(n) === -1);
    rows.push(extra.length
      ? { id: 'approved-tools', stage, label: 'Tool not on the approved list', result: 'fail', action: limits.toolAction || 'WAIT', detail: 'Not approved: ' + extra.slice(0, 10).join(', ') + '.', tools: extra.slice(0, 20) }
      : { id: 'approved-tools', stage, label: 'Approved tools only', result: 'pass', detail: offered.length ? 'All ' + offered.length + ' tool(s) are on the approved list.' : 'No tools offered.' });
  }
  return rows;
}
module.exports = { scan, preChecks, readMaterial, toolsInRequest, invisible };
