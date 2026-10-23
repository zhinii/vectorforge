// VectorForge BYOK relay. Copy unchanged to app/api/cad-chat/route.ts.
// The browser's key is used for this request only; no environment key is read.
import { CAD_SYSTEM } from './cad-relay-system.mjs';

const allowedOrigins = new Set(['https://zhinii.github.io', 'http://127.0.0.1:4226', 'http://localhost:4226']);
const endpoints = new Set([
  'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1',
  'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
  'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
]);
const defaultBase = 'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1';
const clients = new Map<string, number>();
let windowMinute = 0, windowCount = 0, inFlight = 0;

function headers(origin: string) {
  return {
    ...(allowedOrigins.has(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Alibaba-Base',
    'Vary': 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  };
}
function response(origin: string, data: unknown, status = 200) {
  return Response.json(data, { status, headers: headers(origin) });
}

// Bound bytes before JSON parsing, and time out even while receiving a body.
async function readJson(stream: ReadableStream<Uint8Array> | null, maxBytes: number, timeoutMs: number) {
  if (!stream) throw Error('body');
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(Error('timeout')); }, timeoutMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { void reader.cancel().catch(() => {}); throw Error('size'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

export async function GET(request: Request) {
  const origin = request.headers.get('origin') || '';
  return response(origin, { service: 'VectorForge CAD connection', configured: true, auth: 'byok', version: 1 });
}
export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin') || '';
  return new Response(null, { status: allowedOrigins.has(origin) ? 204 : 403, headers: headers(origin) });
}
export async function POST(request: Request) {
  const origin = request.headers.get('origin') || '';
  const reply = (data: unknown, status = 200) => response(origin, data, status);
  if (!allowedOrigins.has(origin)) return reply({ error: 'origin' }, 403);
  const authorization = request.headers.get('authorization') || '';
  // This reference is never put in a cache, log, response, or persistent state.
  const key = /^Bearer ([\x21-\x7e]{1,512})$/.exec(authorization)?.[1];
  if (!key) return reply({ error: 'auth' }, 401);
  const base = request.headers.get('x-alibaba-base') || defaultBase;
  if (!endpoints.has(base)) return reply({ error: 'endpoint' }, 400);
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
    return reply({ error: 'content_type' }, 400);
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > 64000)) return reply({ error: 'size' }, 413);

  // Per-isolate safeguards, not a distributed or guaranteed account spending cap.
  const minute = Math.floor(Date.now() / 60000);
  if (windowMinute !== minute) { windowMinute = minute; windowCount = 0; clients.clear(); }
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const count = clients.get(ip) || 0;
  if (inFlight >= 3 || windowCount >= 60 || count >= 12) return reply({ error: 'rate_limit' }, 429);
  clients.set(ip, count + 1); windowCount++; inFlight++;

  let stage = 'body';
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  let providerTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const body = await readJson(request.body, 64000, 10000);
    if (!body || typeof body !== 'object' || !/^[\w.\-]{1,100}$/.test(body.model || '') ||
      !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 14 ||
      body.messages.some((m: any) => !m || !['system', 'assistant', 'user'].includes(m.role) ||
        typeof m.content !== 'string' || m.content.length > 12000)) return reply({ error: 'request' }, 400);
    const last = body.messages.at(-1);
    if (last.role !== 'user') return reply({ error: 'request' }, 400);
    let task;
    try { task = JSON.parse(last.content); } catch { return reply({ error: 'scene_required' }, 400); }
    if (!task || typeof task.question !== 'string' || !task.question.trim() || task.question.length > 1600 ||
      !Array.isArray(task.scene?.entities) || task.scene.entities.length > 500)
      return reply({ error: 'scene_required' }, 400);
    const messages = [{ role: 'system', content: CAD_SYSTEM },
      ...body.messages.filter((m: any) => m.role !== 'system').slice(-13)
        .map((m: any) => ({ role: m.role, content: m.content }))];
    stage = 'provider';
    providerTimer = setTimeout(abort, 25000);
    const upstream = await fetch(base + '/chat/completions', {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ model: body.model, messages, max_tokens: 2000,
        response_format: { type: 'json_object' }, temperature: .2, stream: false, enable_thinking: false }),
    });
    if (!upstream.ok) {
      void upstream.body?.cancel().catch(() => {});
      return reply({ error: 'provider' }, [400, 401, 403, 404, 429].includes(upstream.status) ? upstream.status : 502);
    }
    stage = 'parse';
    const data = await readJson(upstream.body, 64000, 25000);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length > 12000 || content.includes(key))
      return reply({ error: 'response' }, 502);
    return reply({ choices: [{ message: { content }, finish_reason: data.choices[0].finish_reason === 'length' ? 'length' : 'stop' }] });
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    if (stage === 'body') return reply({ error: reason === 'size' ? 'size' : reason === 'timeout' ? 'timeout' : 'request' }, reason === 'size' ? 413 : reason === 'timeout' ? 408 : 400);
    return reply({ error: controller.signal.aborted || reason === 'timeout' ? 'timeout' : 'connection' }, controller.signal.aborted || reason === 'timeout' ? 504 : 502);
  } finally {
    clearTimeout(providerTimer);
    request.signal.removeEventListener('abort', abort);
    inFlight--;
  }
}
