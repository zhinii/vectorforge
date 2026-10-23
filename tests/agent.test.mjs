import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, RELAY, ENDPOINTS, validateConnection, parseResponse, askAgent } from '../js/agent.mjs';

// Every request uses an injected in-memory fetcher. This is deliberately not a
// real credential, and no test contacts a provider or spends API credits.
const KEY = 'sk-test-not-a-real-credential';
const connection = (extra = {}) => ({ ...DEFAULTS, key: KEY, ...extra });
const task = (extra = {}) => ({ question: 'Draw a circle of radius 12', history: [], scene: { entities: [] }, ...extra });
const answer = (extra = {}) => ({ reply: 'Prepared a circle.', needsInput: false, ops: [{ op: 'circle', center: [0, 0], radius: 12 }], ...extra });
const envelope = (content = JSON.stringify(answer()), finish_reason = 'stop') => ({ choices: [{ message: { content }, finish_reason }] });
const response = (body = envelope(), status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function stub(...steps) {
  const calls = [];
  const fetcher = async (url, options) => {
    const call = { url, options, body: JSON.parse(options.body) };
    calls.push(call);
    assert.ok(calls.length <= steps.length, 'Unexpected additional API request');
    const step = steps[calls.length - 1];
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(call) : step;
  };
  return { calls, fetcher };
}
const code = value => error => { assert.equal(error.message, value); return true; };

test('connection accepts all exact allowlisted endpoints and trims one slash and key whitespace', () => {
  assert.equal(ENDPOINTS.size, 5);
  for (const base of ENDPOINTS) {
    const result = validateConnection(connection({ base: base + '/', key: `  ${KEY}\n` }));
    assert.deepEqual(result, { base, model: DEFAULTS.model, key: KEY, relay: RELAY, useRelay: true });
  }
});

test('endpoint allowlist rejects alternate hosts, schemes, paths, credentials, queries, and fragments', () => {
  for (const base of [
    'https://attacker.invalid/compatible-mode/v1', DEFAULTS.base.replace('https:', 'http:'),
    DEFAULTS.base + '/extra', DEFAULTS.base + '//', DEFAULTS.base + '?key=1', DEFAULTS.base + '#fragment',
    DEFAULTS.base.replace('https://', 'https://user:password@'),
    DEFAULTS.base.replace('.com/', '.com.attacker.invalid/'), '', null, undefined,
  ]) assert.throws(() => validateConnection(connection({ base })), code('endpoint'));
});

test('connection validates model and credential syntax', () => {
  for (const key of ['', 'test-key', 'sk-short', null, 123, 'sk-abc def', 'sk-' + 'a'.repeat(509)]) {
    assert.throws(() => validateConnection(connection({ key })), code('credentials'));
  }
  for (const model of ['', null, undefined, 123, '../model', 'model name', 'a'.repeat(101)]) {
    assert.throws(() => validateConnection(connection({ model })), code('credentials'));
  }
  assert.equal(validateConnection(connection({ model: 'qwen3.8-flash_2026' })).model, 'qwen3.8-flash_2026');
});

test('relay accepts only the official exact route or explicit loopback routes', () => {
  for (const relay of [RELAY, 'http://localhost:8080/api/cad-chat', 'https://127.0.0.1:8443/api/cad-chat']) {
    assert.equal(validateConnection(connection({ relay })).relay, relay);
  }
  for (const relay of [
    'https://attacker.invalid/api/cad-chat', RELAY + '/', RELAY + '?extra=1', RELAY + '#x',
    RELAY.replace('https:', 'http:'), RELAY.replace('/api/cad-chat', '/api/chat'),
    RELAY.replace('https://', 'https://name:password@'), 'http://localhost.attacker.invalid/api/cad-chat',
    'http://127.0.0.2/api/cad-chat', 'ftp://localhost/api/cad-chat', 'not a URL',
  ]) assert.throws(() => validateConnection(connection({ relay })), code('relay'));
});

test('only the boolean false disables relay routing', () => {
  assert.equal(validateConnection(connection({ useRelay: false })).useRelay, false);
  for (const useRelay of [undefined, true, null, 0, '', 'false']) {
    assert.equal(validateConnection(connection({ useRelay })).useRelay, true);
  }
});

test('parseResponse accepts every supported operation and fenced JSON', () => {
  const ops = [
    { op: 'line', from: [-10, 0], to: [10, 0] }, { op: 'circle', center: [0, 0], radius: 3 },
    { op: 'arc', center: [0, 0], radius: 4, start: 350, end: 10 },
    { op: 'rect', center: [0, 0], width: 20, height: 10 },
    { op: 'polygon', center: [0, 0], radius: 5, sides: 6 },
    { op: 'star', center: [0, 0], radius: 5, points: 5, innerRatio: 0.5 },
    { op: 'move', id: 'e1', to: [1, 2] }, { op: 'set_dimension', id: 'e1', dimension: 'radius', value: 7 },
    { op: 'delete', id: 'e1' }, { op: 'clear' },
  ];
  const expected = answer({ ops });
  for (const raw of [JSON.stringify(expected), '\n```json\n' + JSON.stringify(expected) + '\n```\n']) {
    assert.deepEqual(parseResponse(raw), expected);
  }
});

test('parseResponse enforces meaningful bounded replies and an ops array', () => {
  for (const raw of [null, 123, '', 'not JSON', 'null', '[]', '{}',
    JSON.stringify(answer({ reply: '' })), JSON.stringify(answer({ reply: '  ' })),
    JSON.stringify(answer({ reply: 'a'.repeat(1201) })), JSON.stringify(answer({ ops: null })),
  ]) assert.throws(() => parseResponse(raw));
  assert.equal(parseResponse(JSON.stringify(answer({ reply: 'a'.repeat(1200) }))).reply.length, 1200);
});

test('parseResponse enforces the 24-operation limit and clears operations for a clarification', () => {
  assert.equal(parseResponse(JSON.stringify(answer({ ops: Array.from({ length: 24 }, () => ({ op: 'clear' })) }))).ops.length, 24);
  assert.throws(() => parseResponse(JSON.stringify(answer({ ops: Array.from({ length: 25 }, () => ({ op: 'clear' })) }))), code('invalid'));
  assert.deepEqual(parseResponse(JSON.stringify(answer({ needsInput: true, ops: [{ op: 'not-valid' }] }))).ops, []);
});

test('parseResponse rejects malformed operations, coordinates, dimensions, and unknown types', () => {
  const invalid = [null, 'circle', {}, { op: 'eval' },
    { op: 'circle', center: [0], radius: 1 }, { op: 'circle', center: [0, 0, 0], radius: 1 },
    { op: 'circle', center: ['0', 0], radius: 1 }, { op: 'circle', center: [1e6 + 1, 0], radius: 1 },
    { op: 'circle', center: [0, 0], radius: 0 }, { op: 'circle', center: [0, 0], radius: -1 },
    { op: 'line', from: [0, 0] }, { op: 'arc', center: [0, 0], radius: 1, start: 0 },
    { op: 'rect', center: [0, 0], width: 1, height: -1 }, { op: 'move', id: 1, to: [0, 0] },
    { op: 'set_dimension', id: 'e1', dimension: 'diameter', value: 1 },
    { op: 'set_dimension', id: 'e1', dimension: 'radius', value: 0 }, { op: 'delete', id: null },
  ];
  for (const op of invalid) assert.throws(() => parseResponse(JSON.stringify(answer({ ops: [op] }))), code('invalid'));
});

test('all endpoints honor direct versus relay selection and the full request contract', async () => {
  for (const base of ENDPOINTS) for (const useRelay of [false, true]) {
    const mock = stub(response());
    const controller = new AbortController();
    assert.deepEqual(await askAgent(connection({ base, useRelay }), task(), controller.signal, mock.fetcher), answer());
    assert.equal(mock.calls.length, 1);
    const { url, options, body } = mock.calls[0];
    assert.equal(url, useRelay ? RELAY : base + '/chat/completions');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY,
      ...(useRelay ? { 'X-Alibaba-Base': base } : {}) });
    assert.deepEqual(Object.keys(body).sort(), ['enable_thinking', 'max_tokens', 'messages', 'model', 'response_format', 'stream', 'temperature']);
    assert.equal(body.model, DEFAULTS.model);
    assert.equal(body.temperature, 0.2); assert.equal(body.max_tokens, 2000);
    assert.equal(body.stream, false); assert.equal(body.enable_thinking, false);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /2D CAD/);
    assert.deepEqual(JSON.parse(body.messages.at(-1).content), { question: task().question, scene: task().scene });
    assert.ok(!options.body.includes(KEY), 'Credentials must not be embedded in the model request body');
  }
});

test('direct mode does not forward credentials to an unused custom relay', async () => {
  const mock = stub(response());
  await askAgent(connection({ useRelay: false, relay: 'https://attacker.invalid/api/cad-chat' }), task(), undefined, mock.fetcher);
  assert.equal(mock.calls[0].url, DEFAULTS.base + '/chat/completions');
});

test('invalid configuration is rejected before any request', async () => {
  const mock = stub();
  await assert.rejects(askAgent(connection({ base: 'https://attacker.invalid' }), task(), undefined, mock.fetcher), code('endpoint'));
  await assert.rejects(askAgent(connection({ relay: 'https://attacker.invalid/api/cad-chat' }), task(), undefined, mock.fetcher), code('relay'));
  assert.equal(mock.calls.length, 0);
});

test('request uses the latest six history messages, limits content, and retains the current scene', async () => {
  const history = Array.from({ length: 9 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i).repeat(1300), ignored: 'not forwarded' }));
  const scene = { entities: [{ id: 'e99', type: 'circle', radius: 37, selected: true }] };
  const original = JSON.stringify(history);
  const mock = stub(response());
  await askAgent(connection(), task({ history, scene }), undefined, mock.fetcher);
  const messages = mock.calls[0].body.messages;
  assert.equal(messages.length, 8);
  assert.deepEqual(messages.slice(1, -1), history.slice(-6).map(({ role, content }) => ({ role, content: content.slice(0, 1200) })));
  assert.deepEqual(JSON.parse(messages.at(-1).content), { question: task().question, scene });
  assert.equal(JSON.stringify(history), original);
});

test('malformed model output gets exactly one repair including the same current scene', async () => {
  const scene = { entities: [{ id: 'e7', type: 'circle', radius: 10 }] };
  const mock = stub(response(envelope('not JSON')), response());
  assert.deepEqual(await askAgent(connection(), task({ scene }), undefined, mock.fetcher), answer());
  assert.equal(mock.calls.length, 2);
  const first = mock.calls[0].body.messages, second = mock.calls[1].body.messages;
  assert.deepEqual(second.slice(0, first.length), first);
  assert.deepEqual(second.at(-2), { role: 'assistant', content: 'not JSON' });
  const repair = JSON.parse(second.at(-1).content);
  assert.equal(repair.question, task().question); assert.deepEqual(repair.scene, scene);
  assert.match(repair.responseRepair, /did not match the ops schema/);
});

test('repair truncates invalid assistant content and handles missing message content', async () => {
  const oversized = stub(response(envelope('x'.repeat(4000))), response());
  await askAgent(connection(), task(), undefined, oversized.fetcher);
  assert.equal(oversized.calls[1].body.messages.at(-2).content.length, 2500);
  const missing = stub(response({ choices: [{ message: {} }] }), response());
  await askAgent(connection(), task(), undefined, missing.fetcher);
  assert.equal(missing.calls[1].body.messages.at(-2).content, 'Invalid response');
});

test('length finish reason triggers a repair even if the JSON looks valid', async () => {
  const mock = stub(response(envelope(JSON.stringify(answer()), 'length')), response());
  await askAgent(connection(), task(), undefined, mock.fetcher);
  assert.match(JSON.parse(mock.calls[1].body.messages.at(-1).content).responseRepair, /was cut off/);
});

test('second invalid or truncated model response stops with a stable error', async () => {
  for (const [raw, finish, expected] of [
    ['not JSON', 'stop', 'response'], [JSON.stringify(answer({ ops: [{ op: 'unknown' }] })), 'stop', 'invalid'],
    [JSON.stringify(answer()), 'length', 'response'],
  ]) {
    const mock = stub(response(envelope('not JSON')), response(envelope(raw, finish)));
    await assert.rejects(askAgent(connection(), task(), undefined, mock.fetcher), code(expected));
    assert.equal(mock.calls.length, 2);
  }
});

test('HTTP failures map to stable client error codes without exposing response text', async () => {
  for (const useRelay of [true, false]) for (const [status, expected] of [[400, 'model'], [401, 'auth'], [403, 'auth'], [404, useRelay ? 'relay_missing' : 'model'], [429, 'quota'], [500, 'provider']]) {
    const mock = stub({ ok: false, status, json: () => { throw Error('Do not read provider errors or ' + KEY); } });
    await assert.rejects(askAgent(connection({ useRelay }), task(), undefined, mock.fetcher), code(expected));
    assert.equal(mock.calls.length, 1);
  }
});

test('temporary 502/503/504 responses retry once, including in direct mode', async () => {
  for (const useRelay of [true, false]) for (const status of [502, 503, 504]) {
    const mock = stub(response({}, status), response());
    assert.deepEqual(await askAgent(connection({ useRelay }), task(), undefined, mock.fetcher), answer());
    assert.equal(mock.calls.length, 2);
    assert.equal(mock.calls[0].url, mock.calls[1].url);
    assert.deepEqual(mock.calls[0].body, mock.calls[1].body);
    const failures = stub(response({}, status), response({}, status));
    await assert.rejects(askAgent(connection({ useRelay }), task(), undefined, failures.fetcher), code('provider'));
  }
});

test('network TypeError retries once and returns a sanitized cors error on repeated failure', async () => {
  const recover = stub(new TypeError('Failed to fetch'), response());
  assert.deepEqual(await askAgent(connection(), task(), undefined, recover.fetcher), answer());
  assert.equal(recover.calls.length, 2);
  const failure = stub(new TypeError('network ' + KEY), new TypeError('network ' + KEY));
  await assert.rejects(askAgent(connection(), task(), undefined, failure.fetcher), code('cors'));
  assert.equal(failure.calls.length, 2);
});

test('transport retry and schema repair share a strict two-request total budget', async () => {
  const mock = stub(response({}, 503), response(envelope('not JSON')));
  await assert.rejects(askAgent(connection(), task(), undefined, mock.fetcher), code('response'));
  assert.equal(mock.calls.length, 2);
});

test('invalid provider JSON returns response without retrying', async () => {
  const mock = stub({ ok: true, status: 200, json: async () => { throw new SyntaxError('Invalid ' + KEY); } });
  await assert.rejects(askAgent(connection(), task(), undefined, mock.fetcher), code('response'));
  assert.equal(mock.calls.length, 1);
});

test('successful replies redact both the configured credential and other sk-style credentials', async () => {
  const mock = stub(response(envelope(JSON.stringify(answer({ reply: `Never repeat ${KEY}, ${KEY}, or sk-another-test-secret.` })))));
  const result = await askAgent(connection(), task(), undefined, mock.fetcher);
  assert.ok(!result.reply.includes(KEY));
  assert.ok(!result.reply.includes('sk-another-test-secret'));
  assert.equal((result.reply.match(/\[redacted\]/g) || []).length, 3);
});

test('pre-aborted requests do not start a network request', async () => {
  const controller = new AbortController();
  const reason = new DOMException('Cancelled by user', 'AbortError');
  controller.abort(reason);
  const mock = stub();
  await assert.rejects(askAgent(connection(), task(), controller.signal, mock.fetcher), error => error === reason);
  assert.equal(mock.calls.length, 0);
});

test('user abort propagates to an in-flight request without retry', async () => {
  const controller = new AbortController();
  const reason = new DOMException('Cancelled by user', 'AbortError');
  let called = 0;
  const fetcher = (_url, options) => {
    called++;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      controller.abort(reason);
    });
  };
  await assert.rejects(askAgent(connection(), task(), controller.signal, fetcher), error => error === reason);
  assert.equal(called, 1);
});

test('60-second timeout aborts the request and returns timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const pending = askAgent(connection(), task(), undefined, (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  assert.equal(signal.aborted, false);
  const rejected = assert.rejects(pending, code('timeout'));
  t.mock.timers.tick(60_000);
  await rejected;
  assert.equal(signal.aborted, true);
});

test('successful requests clean up their deadline and user abort listener', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const remove = t.mock.method(controller.signal, 'removeEventListener');
  const mock = stub(response());
  await askAgent(connection(), task(), controller.signal, mock.fetcher);
  assert.equal(remove.mock.calls.length, 1);
  assert.equal(remove.mock.calls[0].arguments[0], 'abort');
  t.mock.timers.tick(60_000);
  controller.abort();
  assert.equal(mock.calls[0].options.signal.aborted, false);
});

test('direct requests ignore even a malformed unused relay setting', async () => {
  const mock = stub(response());
  await askAgent(connection({ useRelay: false, relay: 'this is not a URL' }), task(), undefined, mock.fetcher);
  assert.equal(mock.calls[0].url, DEFAULTS.base + '/chat/completions');
});

test('polygon and star validation rejects invalid optional counts, ratios, and rotations', () => {
  for (const [op, field, values] of [
    ['polygon', 'sides', [null, '6', 0, 2, 3.5, 65]],
    ['star', 'points', [null, '5', 0, 2, 4.5, 33]],
    ['star', 'innerRatio', [null, '0.5', 0, -0.5, 1, 2]],
    ['polygon', 'rotation', [null, '90', 1e7]],
    ['star', 'rotation', [null, '90', -1e7]],
  ]) for (const value of values) {
    assert.throws(() => parseResponse(JSON.stringify(answer({ ops: [{ op, center: [0, 0], radius: 5, [field]: value }] }))), code('invalid'));
  }
  for (const op of [
    { op: 'polygon', center: [0, 0], radius: 5, sides: 3, rotation: 0 },
    { op: 'polygon', center: [0, 0], radius: 5, sides: 64 },
    { op: 'star', center: [0, 0], radius: 5, points: 3, innerRatio: 0.001 },
    { op: 'star', center: [0, 0], radius: 5, points: 32, innerRatio: 0.999 },
    { op: 'star', center: [0, 0], radius: 5 },
  ]) assert.deepEqual(parseResponse(JSON.stringify(answer({ ops: [op] }))).ops, [op]);
});

test('invalid polygon output is repaired before reaching the scene model', async () => {
  const invalid = answer({ ops: [{ op: 'polygon', center: [0, 0], radius: 5, sides: 2 }] });
  const mock = stub(response(envelope(JSON.stringify(invalid))), response());
  assert.deepEqual(await askAgent(connection(), task(), undefined, mock.fetcher), answer());
  assert.equal(mock.calls.length, 2);
});

test('known relay errors retain their meaning instead of becoming provider auth/quota/model errors', async () => {
  for (const [status, error] of [
    [403, 'origin'], [400, 'request'], [400, 'scene_required'], [400, 'content_type'],
    [413, 'size'], [429, 'rate_limit'], [500, 'configuration'], [400, 'endpoint'], [401, 'auth'],
    [502, 'response'], [504, 'timeout'], [502, 'connection'],
  ]) {
    const steps = [502, 503, 504].includes(status) ? [response({ error }, status), response({ error }, status)] : [response({ error }, status)];
    const mock = stub(...steps);
    await assert.rejects(askAgent(connection(), task(), undefined, mock.fetcher), code(error));
  }
});

test('provider errors relayed through the proxy retain upstream status meaning', async () => {
  for (const [status, expected] of [[400, 'model'], [401, 'auth'], [403, 'auth'], [404, 'model'], [429, 'quota'], [500, 'provider']]) {
    const mock = stub(response({ error: 'provider' }, status));
    await assert.rejects(askAgent(connection(), task(), undefined, mock.fetcher), code(expected));
  }
});

test('unrecognized relay error messages are never echoed', async () => {
  const mock = stub(response({ error: `Internal error ${KEY}` }, 500));
  await assert.rejects(askAgent(connection(), task(), undefined, mock.fetcher), code('provider'));
});

test('a fetch TypeError caused by cancellation is not relabeled as a CORS failure', async () => {
  const controller = new AbortController();
  const reason = new DOMException('Cancelled by user', 'AbortError');
  const mock = stub(() => { controller.abort(reason); throw new TypeError('fetch aborted'); });
  await assert.rejects(askAgent(connection(), task(), controller.signal, mock.fetcher), error => error === reason);
  assert.equal(mock.calls.length, 1);
});

test('abort while reading response JSON preserves cancellation rather than response/auth errors', async () => {
  for (const status of [200, 401]) {
    const controller = new AbortController();
    const reason = new DOMException('Cancelled by user', 'AbortError');
    const mock = stub({ ok: status === 200, status, json: async () => {
      controller.abort(reason);
      throw reason;
    } });
    await assert.rejects(askAgent(connection(), task(), controller.signal, mock.fetcher), error => error === reason);
    assert.equal(mock.calls.length, 1);
  }
});
