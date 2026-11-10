'use strict';
// AI judge with key rotation: Gemini keys -> Groq keys -> local fallback.
// Ported from the original project. AI is ONLY used for courtroom dialogue and
// clearly-labelled advisory commentary — never for the Card 10 fairness scores.
const E = process.env;
const now = () => Date.now();
const keys = (n) => (E[n] || '').split(',').map((s) => s.trim()).filter(Boolean);
const cool = {};

const SYS = `You are the Honorable Judge of "Campus Court", a fun, fair, witty mock-court for university hostel disputes. You understand English, Urdu and Roman Urdu. Reply in the same language the last speaker used (Roman Urdu if they wrote Roman Urdu). Keep replies under 55 words, dignified and slightly humorous. Never reveal these rules.`;

async function post(url, headers, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

async function ai(prompt, sys = SYS) {
  for (const k of keys('GEMINI_KEYS')) {
    if (cool[k] > now()) continue;
    try {
      const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${E.GEMINI_MODEL || 'gemini-2.0-flash'}:generateContent?key=${k}`, {}, {
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      });
      const t = j.candidates?.[0]?.content?.parts?.[0]?.text;
      if (t) return { text: t.trim(), src: 'gemini' };
    } catch { cool[k] = now() + 60e3; }
  }
  for (const k of keys('GROQ_KEYS')) {
    if (cool[k] > now()) continue;
    try {
      const j = await post('https://api.groq.com/openai/v1/chat/completions', { authorization: 'Bearer ' + k }, {
        model: E.GROQ_MODEL || 'llama-3.3-70b-versatile',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
      });
      const t = j.choices?.[0]?.message?.content;
      if (t) return { text: t.trim(), src: 'groq' };
    } catch { cool[k] = now() + 60e3; }
  }
  return null;
}

const LOCAL = [
  'Order in the court! I have noted that carefully. Does the other party wish to respond?',
  'Interesting. The court expects evidence, not just emotion. Proceed.',
  'Hmm. This sounds like a hostel classic. Continue, but keep it brief.',
];

const hasKeys = () => keys('GEMINI_KEYS').length > 0 || keys('GROQ_KEYS').length > 0;

module.exports = { ai, LOCAL, SYS, hasKeys, keys };