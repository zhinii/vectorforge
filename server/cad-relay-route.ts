// VectorForge CAD relay — deploy alongside the robot relay on the same host,
// e.g. as the route /api/cad-chat. Adapted from six-axis-agent/server/relay-route.ts
// with the same hardening: origin whitelist, endpoint whitelist, bounded body,
// rate limits, server-side key, provider timeout.
//
// Required env vars: ALIBABA_API_KEY (server-side; browser keys are ignored),
// optional ALIBABA_BASE_URL, ALIBABA_MODEL.
import { CAD_SYSTEM } from './cad-relay-system.mjs';

const allowedOrigins = new Set(['https://zhinii.github.io', 'http://127.0.0.1:4226', 'http://localhost:4226']);
const endpoints = new Set([
  'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1',
  'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
  'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
]);
const clients = new Map<string, { minute: number, count: number }>();
let windowMinute = 0, windowCount = 0, inFlight = 0;

function headers(origin: string) {
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Alibaba-Base',
    'Vary': 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
}
function configuration() {
  const key = (process.env.ALIBABA_API_KEY || '').trim();
  const base = process.env.ALIBABA_BASE_URL || 'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1';
  const model = process.env.ALIBABA_MODEL || 'qwen3.8-flash';
  return key && !/\s/.test(key) && key.length <= 512 && endpoints.has(base) && /^[\w.\-]{1,100}$/.test(model)
    ? { key, base, model } : null;
}

export async function GET(request: Request) {
  const origin = request.headers.get('origin') || '';
  return Response.json({ service: 'VectorForge CAD connection', configured: !!configuration() },
    { headers: allowedOrigins.has(origin) ? headers(origin) : { 'Cache-Control': 'no-store' } });
}
export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin') || '';
  return new Response(null, { status: allowedOrigins.has(origin) ? 204 : 403,
    headers: allowedOrigins.has(origin) ? headers(origin) : {} });
}

export async function POST(request: Request) {
  const origin = request.headers.get('origin') || '';
  if (!allowedOrigins.has(origin)) return Response.json({ error: 'origin' }, { status: 403 });
  const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: headers(origin) });
  const config = configuration(); if (!config) return reply({ error: 'server_configuration' }, 503);
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return reply({ error: 'content_type' }, 400);
  let stage = 'body', admitted = false;
  try {
    const reader = request.body?.getReader(); if (!reader) return reply({ error: 'body' }, 400);
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 64000) { await reader.cancel(); return reply({ error: 'size' }, 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 14 ||
      body.messages.some((m: any) => !['system', 'assistant', 'user'].includes(m.role) ||
        typeof m.content !== 'string' || m.content.length > 12000)) return reply({ error: 'request' }, 400);
    const last = body.messages.at(-1); if (last.role !== 'user') return reply({ error: 'request' }, 400);
    // CAD scene envelope: {question, scene:{units, entities:[...]}} — or the bounded repair shape.
    let task; try { task = JSON.parse(last.content); } catch {
      if (typeof last.content !== 'string' || !/Your response (?:was cut off|did not match the ops schema)/.test(last.content) ||
        body.messages.at(-2)?.role !== 'assistant' || body.messages.at(-3)?.role !== 'user')
        return reply({ error: 'scene_required' }, 400);
      try { task = JSON.parse(body.messages.at(-3).content); } catch { return reply({ error: 'scene_required' }, 400); }
    }
    if (typeof task.question !== 'string' || task.question.length > 1600 ||
      !Array.isArray(task.scene?.entities)) return reply({ error: 'scene_required' }, 400);

    const minute = Math.floor(Date.now() / 60000);
    if (windowMinute !== minute) { windowMinute = minute; windowCount = 0; for (const [ip, value] of clients) if (value.minute !== minute) clients.delete(ip); }
    const ip = request.headers.get('cf-connecting-ip') || 'unknown', entry = clients.get(ip) || { minute, count: 0 };
    if (inFlight >= 3 || windowCount >= 60 || entry.count >= 12) return reply({ error: 'rate_limit' }, 429);
    entry.count++; clients.set(ip, entry); windowCount++; inFlight++; admitted = true;

    // Server-side system prompt and key; browser-supplied ones are ignored.
    const messages: any[] = [{ role: 'system', content: CAD_SYSTEM },
      ...body.messages.filter((m: any) => m.role !== 'system').slice(-13)];
    stage = 'provider';
    const signal = AbortSignal.timeout(25000);
    const upstream = await fetch(config.base + '/chat/completions', {
      method: 'POST', redirect: 'manual', signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config.key },
      body: JSON.stringify({ model: config.model, messages, max_tokens: 2000,
        response_format: { type: 'json_object' }, temperature: .2, stream: false, enable_thinking: false }),
    });
    if (!upstream.ok) return reply({ error: 'provider' }, [400, 401, 403, 404, 429].includes(upstream.status) ? upstream.status : 502);
    stage = 'parse';
    const data: any = await upstream.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length > 12000) return reply({ error: 'response' }, 502);
    return reply({ choices: [{ message: { content }, finish_reason: data.choices[0].finish_reason === 'length' ? 'length' : 'stop' }] });
  } catch (error) {
    return reply({ error: 'connection', stage, kind: error instanceof SyntaxError ? 'json' : 'transport' }, 502);
  } finally { if (admitted) inFlight--; }
}
