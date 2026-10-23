// VectorForge agent — Qwen (OpenAI-compatible) connection, CAD ops schema.
// Connection pattern mirrors the six-axis robot simulator: endpoint whitelist,
// relay fallback for token-plan hosts, strict JSON validation with one repair pass.

export const DEFAULTS = {
  base: 'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1',
  model: 'qwen3.8-flash',
};
// The CAD relay (see server/cad-relay-route.ts) must be deployed for browser use:
// Alibaba endpoints send no CORS headers, so direct browser calls are blocked.
export const RELAY = 'https://bnta-robot-lab-connection.zhinii.chatgpt.site/api/cad-chat';

const SYSTEM = `You are the AI designer inside a 2D CAD sketcher. The user asks for vector designs in plain language; you answer with a short reply plus drawing operations. Units are millimetres, coordinates are y-up, origin at canvas centre.
Return JSON only: {"reply":"one short sentence","needsInput":false,"ops":[...]}. Maximum 24 ops. If the request is ambiguous in a way that changes the design (which object, what size), ask ONE short question with needsInput:true and ops:[].
Use the CURRENT scene, not stale conversation. Entities have ids (e1, e2...), types and parameters; selected:true marks the user's selection. Follow-ups like "make it bigger" refer to the selected or most recent entity.
Ops (omit unused fields):
{"op":"text","at":[x,y],"text":"Chris","size":10} (editable single-line lettering; size is font height in millimetres, 1–120 Unicode characters, no control characters)
{"op":"line","from":[x,y],"to":[x,y]}
{"op":"bezier","from":[x,y],"control1":[x,y],"control2":[x,y],"to":[x,y]} (cubic Bezier curve with two control handles)
{"op":"circle","center":[x,y],"radius":r}
{"op":"arc","center":[x,y],"radius":r,"start":deg,"end":deg} (counterclockwise)
{"op":"rect","center":[x,y],"width":w,"height":h}
{"op":"polygon","center":[x,y],"radius":R,"sides":n}
{"op":"star","center":[x,y],"radius":R,"points":n,"innerRatio":0.5}
{"op":"move","id":"e3","to":[x,y]} moves the entity centre (or line midpoint).
{"op":"set_dimension","id":"e2","dimension":"length|radius|width|height|chord|size","value":v} edits a driving dimension; the entity rescales.
{"op":"delete","id":"e1"}  {"op":"clear"}
Create useful stylized vector approximations of animals and organic objects with up to 24 Bezier curves and lines; for example draw a recognizable horse silhouette with legs, neck, head, mane and tail. Do not refuse such designs merely because primitives are limited. Use the text operation for names and lettering, including requests like "draw my name Chris". Explain briefly that animal artwork is stylized, not photorealistic. Text is editable lettering, not outlined cutting paths.
Prefer construction with parameters over raw coordinate lists: use set_dimension for sizes, move for placement. Compose designs from primitives (a gear = circle + star teeth; a plate = rect + circles for holes). Keep every design dimensioned — never leave the user with an undimensioned shape. Sizes the user states are exact; honour them with set_dimension or the radius/width fields. If you cannot fulfil a request, explain briefly and return ops:[]. Never claim an op succeeded before it runs.`;

export const ENDPOINTS = new Set([
  'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1',
  'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
  'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
]);

function validateRelay(relay) {
  let url;
  try { url = new URL(relay || RELAY); } catch { throw Error('relay'); }
  const official = url.origin === new URL(RELAY).origin && url.pathname === '/api/cad-chat';
  const local = ['localhost', '127.0.0.1'].includes(url.hostname) &&
    ['http:', 'https:'].includes(url.protocol) && url.pathname === '/api/cad-chat';
  if ((!official && !local) || url.username || url.password || url.search || url.hash) throw Error('relay');
  return url.href;
}

export function validateConnection({ base, model, key, relay = RELAY, useRelay = true, mode }) {
  if (mode !== undefined && !['server', 'byok'].includes(mode)) throw Error('mode_credentials');
  if (mode === 'server') {
    // Server mode never forwards a stale browser credential or allows direct routing.
    if (useRelay === false) throw Error('mode_credentials');
    return { ...DEFAULTS, key: '', relay: validateRelay(relay), useRelay: true, mode: 'server' };
  }
  base = String(base).replace(/\/$/, '');
  if (!ENDPOINTS.has(base)) throw Error('endpoint');
  if (typeof model !== 'string' || !/^[\w.\-]{1,100}$/.test(model) || typeof key !== 'string' ||
    !/^sk-[A-Za-z0-9._-]{6,508}$/.test(key.trim())) throw Error('credentials');
  const modeField = mode === 'byok' ? { mode } : {};
  if (useRelay === false) return { base, model, key: key.trim(), relay: RELAY, useRelay: false, ...modeField };
  return { base, model, key: key.trim(), relay: validateRelay(relay), useRelay: true, ...modeField };
}

// Public readiness check only: no provider request, credential, or token spend.
// Readiness is not a successful AI connection; only a completed POST proves that.
export async function readRelayStatus(connection = {}, signal, fetcher = fetch) {
  const relay = validateRelay(connection.relay);
  signal?.throwIfAborted();
  let response;
  try {
    response = await fetcher(relay, { method: 'GET', signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof TypeError) throw Error('cors');
    throw error;
  }
  signal?.throwIfAborted();
  if (!response.ok) throw Error(response.status === 404 ? 'relay_missing' : 'provider');
  let data;
  try { data = await response.json(); } catch { signal?.throwIfAborted(); throw Error('response'); }
  signal?.throwIfAborted();
  if (!data || data.service !== 'VectorForge CAD connection' || data.version !== 2 ||
      data.auth !== 'server+byok' || data.defaultMode !== 'server' || typeof data.serverConfigured !== 'boolean' ||
      (data.serverConfigured && (typeof data.serverModel !== 'string' || !/^[\w.\-]{1,100}$/.test(data.serverModel)))) throw Error('response');
  return { service: data.service, version: data.version, configured: data.configured === true,
    auth: data.auth, defaultMode: data.defaultMode, serverConfigured: data.serverConfigured, serverModel: data.serverConfigured ? data.serverModel : undefined };
}

const OP_TYPES = ['text', 'line', 'bezier', 'circle', 'arc', 'rect', 'polygon', 'star', 'move', 'set_dimension', 'delete', 'clear'];
const okNum = v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6;
const isPt = p => Array.isArray(p) && p.length === 2 && p.every(okNum);
const optionalCount = (n, max) => n === undefined || (Number.isInteger(n) && n >= 3 && n <= max);
const optionalRotation = n => n === undefined || okNum(n);

function validOp(op) {
  if (!op || typeof op !== 'object' || !OP_TYPES.includes(op.op)) return false;
  switch (op.op) {
    case 'text': return isPt(op.at) && typeof op.text === 'string' && op.text.trim().length > 0 &&
      Array.from(op.text).length <= 120 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(op.text) && okNum(op.size) && op.size > 0;
    case 'line': return isPt(op.from) && isPt(op.to);
    case 'bezier': return isPt(op.from) && isPt(op.control1) && isPt(op.control2) && isPt(op.to);
    case 'circle': return isPt(op.center) && okNum(op.radius) && op.radius > 0;
    case 'arc': return isPt(op.center) && okNum(op.radius) && op.radius > 0 && okNum(op.start) && okNum(op.end);
    case 'rect': return isPt(op.center) && okNum(op.width) && okNum(op.height) && op.width > 0 && op.height > 0;
    case 'polygon': return isPt(op.center) && okNum(op.radius) && op.radius > 0 &&
      optionalCount(op.sides, 64) && optionalRotation(op.rotation);
    case 'star': return isPt(op.center) && okNum(op.radius) && op.radius > 0 &&
      optionalCount(op.points, 32) && optionalRotation(op.rotation) &&
      (op.innerRatio === undefined || (okNum(op.innerRatio) && op.innerRatio > 0 && op.innerRatio < 1));
    case 'move': return typeof op.id === 'string' && isPt(op.to);
    case 'set_dimension': return typeof op.id === 'string' &&
      ['length', 'radius', 'width', 'height', 'chord', 'size'].includes(op.dimension) && okNum(op.value) && op.value > 0;
    case 'delete': return typeof op.id === 'string';
    case 'clear': return true;
  }
}

export function parseResponse(raw) {
  if (typeof raw !== 'string') throw Error('response');
  const result = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  if (!result || typeof result.reply !== 'string' || !result.reply.trim() || result.reply.length > 1200) throw Error('response');
  if (!Array.isArray(result.ops)) throw Error('response');
  if (result.ops.length > 24) throw Error('invalid');
  const ops = result.needsInput === true ? [] : result.ops;
  if (!ops.every(validOp)) throw Error('invalid');
  return { reply: result.reply, needsInput: result.needsInput === true, ops };
}

export async function askAgent(connection, task, signal, fetcher = fetch) {
  const controller = new AbortController();
  const forward = () => controller.abort(signal.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener('abort', forward, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 60000);
  try { return await requestAgent(connection, task, controller.signal, fetcher); }
  catch (error) { if (timedOut) throw Error('timeout'); throw error; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', forward); }
}

async function requestAgent(connection, { question, history, scene, language }, signal, fetcher) {
  const config = validateConnection(connection);
  const responseLanguage = language === 'zh' ? 'zh' : 'en';
  // The relay reads the final user JSON task. Keep this field in repair tasks too.
  // Omission preserves the legacy request contract; callers opt in with language.
  const languageField = language === undefined ? {} : { language: responseLanguage };
  const languageInstruction = responseLanguage === 'zh'
    ? 'Write the reply and any clarification question in Simplified Chinese (简体中文).'
    : 'Write the reply and any clarification question in English.';
  const messages = [
    { role: 'system', content: SYSTEM + '\n' + languageInstruction + ' Keep all JSON field names, operation names, dimension keys, and entity IDs in the defined English schema. Do not translate CAD operations.' },
    ...history.slice(-6).map(m => ({ role: m.role, content: String(m.content).slice(0, 1200) })),
    { role: 'user', content: JSON.stringify({ question, scene, ...languageField }) },
  ];
  const needsRelay = config.useRelay;
  const relayUrl = config.relay;

  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    let response;
    try {
      response = await fetcher(needsRelay ? relayUrl : config.base + '/chat/completions', {
        method: 'POST', signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { 'Content-Type': 'application/json',
          ...(config.mode === 'server' ? { 'X-VectorForge-Auth': 'server' } : {
            'Authorization': 'Bearer ' + config.key,
            ...(needsRelay ? { 'X-Alibaba-Base': config.base } : {}),
            ...(needsRelay && config.mode === 'byok' ? { 'X-VectorForge-Auth': 'byok' } : {}),
          }) },
        body: JSON.stringify({ model: config.model, messages, ...(needsRelay ? languageField : {}), temperature: 0.2, max_tokens: 2000,
          response_format: { type: 'json_object' }, stream: false, enable_thinking: false }),
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (attempt === 0 && error instanceof TypeError && !signal?.aborted) continue;
      // TypeError after retry = browser blocked the cross-origin call (no CORS
      // headers on Alibaba endpoints) or the network is down.
      if (error instanceof TypeError) throw Error('cors');
      throw error;
    }
    if (attempt === 0 && [502, 503, 504].includes(response.status)) continue;
    if (!response.ok) {
      // Relay validation/rate-limit failures are not provider auth/quota failures.
      // Accept only fixed codes; never echo arbitrary error text or credentials.
      let relayError;
      if (needsRelay) {
        try { relayError = (await response.json())?.error; } catch { /* Bare HTTP failure. */ }
        signal?.throwIfAborted();
        if (['origin', 'request', 'scene_required', 'content_type', 'size', 'rate_limit',
          'configuration', 'server_configuration', 'mode_credentials', 'endpoint', 'auth', 'response', 'timeout', 'connection'].includes(relayError)) {
          throw Error(relayError);
        }
        if (response.status === 404 && relayError !== 'provider') throw Error('relay_missing');
      }
      throw Error(({ 401: 'auth', 403: 'auth', 429: 'quota', 400: 'model', 404: 'model' })[response.status] || 'provider');
    }
    let data;
    try { data = await response.json(); } catch {
      signal?.throwIfAborted();
      throw Error('response');
    }
    signal?.throwIfAborted();
    const raw = data?.choices?.[0]?.message?.content;
    try {
      if (data?.choices?.[0]?.finish_reason === 'length') throw Error('truncated');
      const result = parseResponse(raw);
      if (config.key) result.reply = result.reply.replaceAll(config.key, '[redacted]');
      result.reply = result.reply.replace(/sk-[A-Za-z0-9._-]{6,}/g, '[redacted]');
      return result;
    } catch (error) {
      if (attempt === 0) {
        messages.push(
          { role: 'assistant', content: typeof raw === 'string' ? raw.slice(0, 2500) : 'Invalid response' },
          { role: 'user', content: JSON.stringify({ question, scene, ...languageField, responseRepair:
            `Your response ${error.message === 'truncated' ? 'was cut off' : 'did not match the ops schema'}. Return one complete compact JSON object {"reply","needsInput","ops"} using only the defined op types.` }) });
        continue;
      }
      throw Error(error.message === 'invalid' ? 'invalid' : 'response');
    }
  }
}

