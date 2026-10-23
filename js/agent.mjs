// VectorForge agent — Qwen (OpenAI-compatible) connection, CAD ops schema.
// Connection pattern mirrors the six-axis robot simulator: endpoint whitelist,
// relay fallback for token-plan hosts, strict JSON validation with one repair pass.

export const DEFAULTS = {
  base: 'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1',
  model: 'qwen3.8-flash',
};
export const RELAY = 'https://bnta-robot-lab-connection.zhinii.chatgpt.site/api/chat';

const SYSTEM = `You are the AI designer inside a 2D CAD sketcher. The user asks for vector designs in plain language; you answer with a short reply plus drawing operations. Units are millimetres, coordinates are y-up, origin at canvas centre.
Return JSON only: {"reply":"one short sentence","needsInput":false,"ops":[...]}. Maximum 24 ops. If the request is ambiguous in a way that changes the design (which object, what size), ask ONE short question with needsInput:true and ops:[].
Use the CURRENT scene, not stale conversation. Entities have ids (e1, e2...), types and parameters; selected:true marks the user's selection. Follow-ups like "make it bigger" refer to the selected or most recent entity.
Ops (omit unused fields):
{"op":"line","from":[x,y],"to":[x,y]}
{"op":"circle","center":[x,y],"radius":r}
{"op":"arc","center":[x,y],"radius":r,"start":deg,"end":deg} (counterclockwise)
{"op":"rect","center":[x,y],"width":w,"height":h}
{"op":"polygon","center":[x,y],"radius":R,"sides":n}
{"op":"star","center":[x,y],"radius":R,"points":n,"innerRatio":0.5}
{"op":"move","id":"e3","to":[x,y]} moves the entity centre (or line midpoint).
{"op":"set_dimension","id":"e2","dimension":"length|radius|width|height","value":v} edits a driving dimension; the entity rescales.
{"op":"delete","id":"e1"}  {"op":"clear"}
Prefer construction with parameters over raw coordinate lists: use set_dimension for sizes, move for placement. Compose designs from primitives (a gear = circle + star teeth; a plate = rect + circles for holes). Keep every design dimensioned — never leave the user with an undimensioned shape. Sizes the user states are exact; honour them with set_dimension or the radius/width fields. If you cannot fulfil a request, explain briefly and return ops:[]. Never claim an op succeeded before it runs.`;

export function validateConnection({ base, model, key }) {
  const url = new URL(base);
  // Only send the key to Alibaba's API domains, never a model-provided URL.
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port ||
    !['qianwenaiapi.com', 'aliyuncs.com'].some(h => url.hostname.endsWith('.' + h))) throw Error('endpoint');
  if (!/^[\w.\-]{1,100}$/.test(model) || typeof key !== 'string' || !key.trim() || key.length > 512) throw Error('credentials');
  return { base: base.replace(/\/$/, ''), model, key: key.trim() };
}

const OP_TYPES = ['line', 'circle', 'arc', 'rect', 'polygon', 'star', 'move', 'set_dimension', 'delete', 'clear'];
const isPt = p => Array.isArray(p) && p.length >= 2 && p.slice(0, 2).every(v => Number.isFinite(Number(v)));
const okNum = v => Number.isFinite(Number(v));

function validOp(op) {
  if (!op || typeof op !== 'object' || !OP_TYPES.includes(op.op)) return false;
  switch (op.op) {
    case 'line': return isPt(op.from) && isPt(op.to);
    case 'circle': return isPt(op.center) && okNum(op.radius) && op.radius > 0;
    case 'arc': return isPt(op.center) && okNum(op.radius) && op.radius > 0;
    case 'rect': return isPt(op.center) && okNum(op.width) && okNum(op.height) && op.width > 0 && op.height > 0;
    case 'polygon': return isPt(op.center) && okNum(op.radius) && op.radius > 0;
    case 'star': return isPt(op.center) && okNum(op.radius) && op.radius > 0;
    case 'move': return typeof op.id === 'string' && isPt(op.to);
    case 'set_dimension': return typeof op.id === 'string' &&
      ['length', 'radius', 'width', 'height'].includes(op.dimension) && okNum(op.value) && op.value > 0;
    case 'delete': return typeof op.id === 'string';
    case 'clear': return true;
  }
}

export function parseResponse(raw) {
  if (typeof raw !== 'string') throw Error('response');
  const result = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  if (!result || typeof result.reply !== 'string' || !result.reply.trim() || result.reply.length > 1200) throw Error('response');
  if (!Array.isArray(result.ops)) throw Error('response');
  const ops = result.needsInput === true ? [] : result.ops.slice(0, 24);
  if (!ops.every(validOp)) throw Error('invalid');
  return { reply: result.reply, needsInput: result.needsInput === true, ops };
}

export async function askAgent(connection, { question, history, scene }, signal, fetcher = fetch) {
  const config = validateConnection(connection);
  const messages = [
    { role: 'system', content: SYSTEM },
    ...history.slice(-6).map(m => ({ role: m.role, content: String(m.content).slice(0, 1200) })),
    { role: 'user', content: JSON.stringify({ question, scene }) },
  ];
  const needsRelay = new URL(config.base).hostname.startsWith('token-plan.') && connection.useRelay !== false;

  for (let attempt = 0; attempt < 2; attempt++) {
    let response;
    try {
      response = await fetcher(needsRelay ? RELAY : config.base + '/chat/completions', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json',
          ...(!needsRelay ? { 'Authorization': 'Bearer ' + config.key } : {}),
          ...(needsRelay ? { 'X-Alibaba-Base': config.base, 'Authorization': 'Bearer ' + config.key } : {}) },
        body: JSON.stringify({ model: config.model, messages, temperature: 0.2, max_tokens: 2000,
          response_format: { type: 'json_object' }, stream: false, enable_thinking: false }),
      });
    } catch (error) {
      if (attempt === 0 && error instanceof TypeError && !signal?.aborted) continue;
      throw error;
    }
    if (attempt === 0 && [502, 503, 504].includes(response.status)) continue;
    if (!response.ok) {
      throw Error(({ 401: 'auth', 403: 'auth', 429: 'quota', 400: 'model', 404: 'model' })[response.status] || 'provider');
    }
    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content;
    try {
      if (data?.choices?.[0]?.finish_reason === 'length') throw Error('truncated');
      return parseResponse(raw);
    } catch (error) {
      if (attempt === 0) {
        messages.push(
          { role: 'assistant', content: typeof raw === 'string' ? raw.slice(0, 2500) : 'Invalid response' },
          { role: 'user', content: JSON.stringify({ question, scene, responseRepair:
            `Your response ${error.message === 'truncated' ? 'was cut off' : 'did not match the ops schema'}. Return one complete compact JSON object {"reply","needsInput","ops"} using only the defined op types.` }) });
        continue;
      }
      throw Error(error.message === 'invalid' ? 'invalid' : 'response');
    }
  }
}
