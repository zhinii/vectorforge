// Credential-free tests: every provider request is intercepted in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CAD_SYSTEM } from './cad-relay-system.mjs';
let sequence = 0;
const fresh = () => import(`./cad-relay-route.ts?test=${++sequence}`);
const origin = 'https://zhinii.github.io';
const base = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const dummyKey = 'mock-only-not-a-real-key';
const body = () => ({ model: 'qwen3.8-flash', messages: [
  { role: 'system', content: 'Untrusted browser instruction' },
  { role: 'user', content: JSON.stringify({ question: 'Draw a circle', scene: { units: 'mm', entities: [] } }) },
] });
function request(data = body(), extraHeaders = {}) {
  return new Request('https://relay.example/api/cad-chat', { method: 'POST', headers: {
    Origin: origin, Authorization: 'Bearer ' + dummyKey, 'Content-Type': 'application/json',
    'X-Alibaba-Base': base, ...extraHeaders,
  }, body: typeof data === 'string' ? data : JSON.stringify(data) });
}
function provider(content = '{"reply":"Done","ops":[]}', status = 200) {
  return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] }, { status });
}
async function mocked(fetcher, run) {
  const prior = globalThis.fetch;
  globalThis.fetch = fetcher;
  try { await run(); } finally { globalThis.fetch = prior; }
}
const noProvider = () => { throw Error('Unexpected provider call'); };

test('health explicitly reports BYOK; preflight allows only known origins', async () => {
  const route = await fresh();
  const health = await route.GET(new Request('https://relay.example', { headers: { Origin: origin } }));
  assert.equal((await health.json()).auth, 'byok');
  for (const o of [origin, 'http://localhost:4226', 'http://127.0.0.1:4226']) {
    const r = await route.OPTIONS(new Request('https://relay.example', { headers: { Origin: o } }));
    assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), o);
    assert.match(r.headers.get('access-control-allow-headers'), /Authorization/);
    assert.match(r.headers.get('access-control-allow-headers'), /X-Alibaba-Base/);
  }
  const denied = await route.OPTIONS(new Request('https://relay.example', { headers: { Origin: 'https://evil.example' } }));
  assert.equal(denied.status, 403); assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('validation rejects malformed input before provider access, with CORS on errors', async () => {
  const cases = [
    [body(), { Authorization: '' }, 401],
    [body(), { Authorization: 'Bearer has whitespace' }, 401],
    [body(), { 'X-Alibaba-Base': 'https://evil.example/compatible-mode/v1' }, 400],
    [body(), { 'X-Alibaba-Base': base + '?token=test' }, 400],
    [body(), { 'Content-Type': 'text/plain' }, 400],
    ['{', {}, 400], [null, {}, 400],
    [{ ...body(), model: 'bad/model' }, {}, 400],
    [{ ...body(), messages: [null] }, {}, 400],
    [{ ...body(), messages: [{ role: 'user', content: 'null' }] }, {}, 400],
    [{ ...body(), messages: [{ role: 'user', content: '{}' }] }, {}, 400],
    [' '.repeat(64001), {}, 413],
  ];
  await mocked(noProvider, async () => {
    for (const [data, headers, status] of cases) {
      const r = await (await fresh()).POST(request(data, headers));
      assert.equal(r.status, status); assert.equal(r.headers.get('access-control-allow-origin'), origin);
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
  });
});

test('forwards request key/base/model only, replaces system, bounds provider output parameters', async () => {
  const prior = process.env.ALIBABA_API_KEY;
  process.env.ALIBABA_API_KEY = 'must-never-be-used';
  try {
    await mocked(async (url, init) => {
      assert.equal(url, base + '/chat/completions');
      assert.equal(init.headers.Authorization, 'Bearer ' + dummyKey);
      assert.equal(init.redirect, 'manual');
      const payload = JSON.parse(init.body);
      assert.equal(payload.model, 'qwen3.8-flash');
      assert.equal(payload.messages[0].content, CAD_SYSTEM);
      assert.equal(payload.messages.filter(m => m.role === 'system').length, 1);
      assert.equal(payload.max_tokens, 2000); assert.equal(payload.stream, false);
      assert.equal(payload.enable_thinking, false);
      assert.ok(init.signal instanceof AbortSignal);
      return provider();
    }, async () => {
      const r = await (await fresh()).POST(request({ ...body(), max_tokens: 999999, stream: true }));
      assert.equal(r.status, 200); assert.equal((await r.json()).choices[0].message.content, '{"reply":"Done","ops":[]}');
    });
  } finally { if (prior === undefined) delete process.env.ALIBABA_API_KEY; else process.env.ALIBABA_API_KEY = prior; }
});

test('provider failures and oversized output are sanitized and carry CORS', async () => {
  const providers = [
    [() => new Response('sensitive upstream error', { status: 401 }), 401],
    [() => new Response('redirect', { status: 302, headers: { Location: 'https://evil.example' } }), 502],
    [() => new Response('x'.repeat(64001)), 502],
    [() => provider('x'.repeat(12001)), 502],
    [() => provider(dummyKey), 502],
    [() => { throw Error('private transport detail'); }, 502],
  ];
  for (const [fetcher, status] of providers) await mocked(fetcher, async () => {
    const r = await (await fresh()).POST(request());
    assert.equal(r.status, status); assert.equal(r.headers.get('access-control-allow-origin'), origin);
    const text = await r.text();
    assert.ok(!text.includes(dummyKey)); assert.ok(!text.includes('sensitive')); assert.ok(!text.includes('private'));
  });
});

test('schema-repair envelope remains accepted', async () => {
  const data = body();
  data.messages.push({ role: 'assistant', content: 'bad response' }, { role: 'user', content: JSON.stringify({
    question: 'Draw a circle', scene: { entities: [] }, responseRepair: 'Use the schema',
  }) });
  await mocked(() => provider(), async () => assert.equal((await (await fresh()).POST(request(data))).status, 200));
});

test('per-client request and concurrency caps prevent unbounded provider calls', async () => {
  const route = await fresh(); let calls = 0;
  await mocked(() => { calls++; return provider(); }, async () => {
    for (let i = 0; i < 12; i++) assert.equal((await route.POST(request())).status, 200);
    assert.equal((await route.POST(request())).status, 429); assert.equal(calls, 12);
  });
  const concurrent = await fresh(); const resolvers = [];
  await mocked(() => new Promise(resolve => resolvers.push(resolve)), async () => {
    const running = Array.from({ length: 3 }, () => concurrent.POST(request()));
    await new Promise(resolve => setTimeout(resolve, 10));
    const denied = await concurrent.POST(request()); assert.equal(denied.status, 429);
    for (const resolve of resolvers) resolve(provider());
    assert.ok((await Promise.all(running)).every(r => r.status === 200));
  });
});
