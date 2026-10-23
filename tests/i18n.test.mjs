import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { catalogs, t, setLanguage, getLanguage, applyTranslations } from '../js/i18n.mjs';
import { askAgent, DEFAULTS, parseResponse, validateConnection, readRelayStatus } from '../js/agent.mjs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const decode = value => value.replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&amp;', '&');
const task = language => ({ question: 'Draw a curve', history: [], scene: { units: 'mm', entities: [] }, language });
const connection = useRelay => ({ ...DEFAULTS, key: 'sk-local-test-only', useRelay });
const response = raw => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: raw } }] }) });
const validReply = JSON.stringify({ reply: '已创建曲线。', ops: [{ op: 'bezier', from: [0, 0], control1: [5, 10], control2: [15, 10], to: [20, 0] }] });

test('both catalogs have identical keys and nonempty text', () => {
  assert.deepEqual(Object.keys(catalogs.en), Object.keys(catalogs.zh));
  for (const lang of ['en', 'zh']) for (const [key, text] of Object.entries(catalogs[lang])) {
    assert.equal(typeof text, 'string', `${lang}: ${key}`);
    assert.ok(text.trim(), `${lang}: ${key}`);
  }
  assert.ok(Object.keys(catalogs.en).length > 130);
});

test('language is explicit, normalized, deterministic, and safe for unknown text', () => {
  setLanguage('en'); assert.equal(getLanguage(), 'en'); assert.equal(t('Select'), 'Select');
  setLanguage('zh'); assert.equal(t('Select'), '选择'); assert.equal(t('not a known UI message'), 'not a known UI message');
  assert.equal(t('coordinates', { x: -12.5, y: 0 }), '-12.5, 0 毫米');
  assert.equal(t('dimension.title', { id: 'e8', dimension: t('radius') }), 'e8：半径');
  assert.equal(setLanguage('zh-CN'), 'zh'); assert.equal(setLanguage('zh-Hans'), 'zh');
  assert.equal(setLanguage('fr'), 'en'); assert.equal(t('coordinates', { x: -12.5, y: 0 }), '-12.5, 0 mm');
  assert.equal(t('unknown {x}', { x: '<script>' }), 'unknown <script>');
});

test('every marked static label, help text, tooltip and accessible name has translations', () => {
  const keys = [...html.matchAll(/data-i18n(?:-(?:title|aria-label|placeholder))?="([^"]*)"/g)].map(m => decode(m[1]));
  assert.ok(keys.length >= 60, 'Static UI is covered, not just the toolbar');
  for (const key of keys) assert.ok(Object.hasOwn(catalogs.zh, key), `Missing Chinese translation: ${key}`);
  for (const id of ['language-toggle', 'copy-selected', 'paste-selected', 'snap-toggle', 'measurements-toggle']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /data-tool="bezier"/);
  assert.match(html, /id="snap-toggle"[^>]*aria-pressed="true"/);
  assert.match(html, /button type="button" id="language-toggle"/);
  assert.doesNotMatch(html, /select id="language-/);
});

test('static translation changes only text and requested attributes and switches back cleanly', () => {
  const items = [...html.matchAll(/<(\w+)\b([^<>]*data-i18n[^<>]*)>/g)].map(m => {
    const attrs = Object.fromEntries([...m[2].matchAll(/([\w-]+)="([^"]*)"/g)].map(a => [a[1], decode(a[2])]));
    return { attrs, textContent: 'initial', getAttribute: key => attrs[key], setAttribute: (key, value) => { attrs[key] = value; } };
  });
  const select = { attrs: {}, setAttribute(key,value) { this.attrs[key]=value; } };
  const root = { documentElement: {}, getElementById: id => id === 'language-toggle' ? select : null,
    querySelectorAll: selector => items.filter(item => Object.hasOwn(item.attrs, selector.slice(1, -1))) };
  for (const language of ['zh', 'en', 'zh', 'en']) {
    setLanguage(language); applyTranslations(root);
    assert.equal(root.documentElement.lang, language === 'zh' ? 'zh-CN' : 'en');
    assert.equal(select.textContent, language === 'en' ? '中文' : 'English');
    assert.equal(select.attrs['aria-label'], language === 'en' ? 'Switch to Chinese' : '切换为英文');
    for (const item of items) {
      if (item.attrs['data-i18n']) assert.equal(item.textContent, catalogs[language][item.attrs['data-i18n']]);
      for (const attribute of ['title', 'aria-label', 'placeholder']) if (item.attrs[`data-i18n-${attribute}`]) {
        assert.equal(item.attrs[attribute], catalogs[language][item.attrs[`data-i18n-${attribute}`]]);
      }
    }
  }
  assert.doesNotThrow(() => applyTranslations(null));
});

test('generated dimensions, coordinates, timeline entries and connection status localize without mutating IDs', () => {
  setLanguage('zh');
  for (const [source, expected] of [
    ['e2: radius', 'e2：半径'], ['R12.5', '半径 12.5 毫米'], ['-2.5, 30 mm', '-2.5, 30 毫米'],
    ['e3 width = 25 mm', 'e3 宽度 = 25 毫米'], ['move e3 → (1,-2)', '移动 e3 → (1,-2)'],
    ['delete e3', '删除 e3'], ['circle R10 at (0,0)', '圆 R10，中心 (0,0)'],
    ['Font size 10 mm', '字号 10 毫米'], ['text “Chris” size 10 at (0,0)', '文字“Chris” 字号 10，位置 (0,0)'],
    ['Bézier (0,0) → (20,0)', '贝塞尔曲线 (0,0) → (20,0)'], ['Chord 20 mm', '弦长 20 毫米'],
    ['line (0,0) → (10,20)', '直线 (0,0) → (10,20)'], ['polygon 6 sides R20', '多边形 6 边 R20'],
    ['Connected to qwen3.8-flash', '已连接至 qwen3.8-flash'],
  ]) assert.equal(t(source), expected);
  assert.equal(t('Connected to test. Describe a design, or use the drawing tools.'), '已连接至 test。请描述设计需求，或使用绘图工具。');
  assert.equal(t('Connection test failed. The request timed out. Try again.'), '连接测试失败。 请求超时，请重试。');
  setLanguage('en');
});

test('all existing relay/provider error explanations and range validation are covered in Chinese', () => {
  const source = readFileSync(new URL('../js/main.mjs', import.meta.url), 'utf8');
  const errors = /const ERRORS = \{([^]*?)\n\};/.exec(source);
  assert.ok(errors);
  setLanguage('zh');
  for (const match of errors[1].matchAll(/:\s*'([^']+)'/g)) {
    assert.ok(Object.hasOwn(catalogs.zh, match[1]), `Untranslated error: ${match[1]}`);
    assert.notEqual(t(match[1]), match[1]);
  }
  assert.notEqual(t('Enter a positive value up to 1,000,000 mm.'), 'Enter a positive value up to 1,000,000 mm.');
  setLanguage('en');
});

test('selected reply language reaches relay task and system while CAD schema stays English', async () => {
  for (const useRelay of [true, false]) for (const language of ['en', 'zh']) {
    let body;
    const result = await askAgent(connection(useRelay), task(language), undefined, async (_url, options) => {
      body = JSON.parse(options.body); return response(validReply);
    });
    assert.equal(JSON.parse(body.messages.at(-1).content).language, language);
    assert.match(body.messages[0].content, language === 'zh' ? /Simplified Chinese/ : /in English/);
    assert.match(body.messages[0].content, /Keep all JSON field names, operation names, dimension keys, and entity IDs/);
    if (useRelay) assert.equal(body.language, language); else assert.equal(body.language, undefined);
    assert.equal(result.ops[0].op, 'bezier'); assert.deepEqual(result.ops[0].control1, [5, 10]);
    assert.equal(result.reply, '已创建曲线。');
  }
});

test('repair keeps language and current scene; unsupported language falls back to English', async () => {
  const calls = [];
  const original = task('zh');
  await askAgent(connection(true), original, undefined, async (_url, options) => {
    calls.push(JSON.parse(options.body)); return response(calls.length === 1 ? 'broken response' : validReply);
  });
  assert.equal(calls.length, 2);
  for (const body of calls) {
    const last = JSON.parse(body.messages.at(-1).content);
    assert.equal(body.language, 'zh'); assert.equal(last.language, 'zh'); assert.deepEqual(last.scene, original.scene);
  }
  await askAgent(connection(true), task('unsafe-arbitrary-instruction'), undefined, async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.language, 'en'); assert.equal(JSON.parse(body.messages.at(-1).content).language, 'en');
    assert.ok(!options.body.includes('unsafe-arbitrary-instruction')); return response(validReply);
  });
});

test('Bezier operations require both control handles and finite bounded coordinates', () => {
  assert.equal(parseResponse(validReply).ops[0].op, 'bezier');
  const valid = JSON.parse(validReply);
  for (const changed of [{ control1: undefined }, { control2: [0] }, { control1: ['5', 10] }, { to: [1e7, 0] }]) {
    assert.throws(() => parseResponse(JSON.stringify({ ...valid, ops: [{ ...valid.ops[0], ...changed }] })), /invalid/);
  }
});

test('server mode validates relay and strips stale BYOK credentials without needing client config', () => {
  const config = validateConnection({ mode: 'server', key: 'sk-stale-never-forward', model: 'ignored', base: 'https://ignored.invalid' });
  assert.equal(config.mode, 'server'); assert.equal(config.key, ''); assert.equal(config.model, DEFAULTS.model);
  assert.equal(config.useRelay, true);
  for (const extra of [{ relay: 'https://attacker.invalid/api/cad-chat' }, { relay: 'http://localhost.attacker.invalid/api/cad-chat' }, { relay: 'https://localhost/api/cad-chat?x=1' }]) {
    assert.throws(() => validateConnection({ mode: 'server', ...extra }), /relay/);
  }
  assert.throws(() => validateConnection({ mode: 'server', useRelay: false }), /mode_credentials/);
  assert.throws(() => validateConnection({ mode: 'unknown' }), /mode_credentials/);
});

test('server requests never transmit browser credentials and do not corrupt replies with empty-key redaction', async () => {
  const stale = 'sk-stale-never-forward';
  const result = await askAgent({ mode: 'server', key: stale }, task('zh'), undefined, async (_url, options) => {
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json', 'X-VectorForge-Auth': 'server' });
    assert.ok(!JSON.stringify(options).includes(stale));
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    return response(validReply);
  });
  assert.equal(result.reply, '已创建曲线。');
});

test('explicit BYOK has its own mode header and never falls back to server after rejection', async () => {
  let count = 0;
  await assert.rejects(askAgent({ ...connection(true), mode: 'byok' }, task('en'), undefined, async (_url, options) => {
    count++;
    assert.equal(options.headers['X-VectorForge-Auth'], 'byok');
    assert.equal(options.headers.Authorization, 'Bearer sk-local-test-only');
    return { ok: false, status: 401, json: async () => ({ error: 'auth' }) };
  }), /auth/);
  assert.equal(count, 1);
  await assert.rejects(askAgent({ ...connection(true), mode: 'byok', key: '' }, task('en'), undefined, async () => { throw Error('must not fetch'); }), /credentials/);
});

test('server configuration and mode mismatch errors retain their precise meaning', async () => {
  for (const [status, error] of [[503, 'server_configuration'], [400, 'mode_credentials']]) {
    let count = 0;
    await assert.rejects(askAgent({ mode: 'server' }, task('en'), undefined, async () => {
      count++; return { ok: false, status, json: async () => ({ error }) };
    }), new RegExp(error));
    assert.equal(count, status === 503 ? 2 : 1);
  }
});

const health = { service: 'VectorForge CAD connection', configured: true, auth: 'server+byok', defaultMode: 'server', serverConfigured: true, serverModel: 'qwen3.8-flash', version: 2 };
test('relay readiness is a public GET with no auth, body, or AI provider request', async () => {
  let count = 0;
  const result = await readRelayStatus({ key: 'sk-must-not-forward' }, undefined, async (_url, options) => {
    count++; assert.equal(options.method, 'GET'); assert.equal(options.body, undefined); assert.equal(options.headers, undefined);
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.ok(!JSON.stringify(options).includes('sk-')); return { ok: true, json: async () => ({ ...health, private: 'not returned' }) };
  });
  assert.equal(count, 1); assert.deepEqual(result, health); assert.equal(result.private, undefined);
});

test('relay readiness rejects malformed/legacy health and accurately returns missing server key state', async () => {
  for (const data of [null, {}, { ...health, auth: 'byok' }, { ...health, version: 1 }, { ...health, serverConfigured: 'yes' }, { ...health, serverModel: '<script>' }]) {
    await assert.rejects(readRelayStatus({}, undefined, async () => ({ ok: true, json: async () => data })), /response/);
  }
  const { serverModel, ...withoutModel } = health;
  const result = await readRelayStatus({}, undefined, async () => ({ ok: true, json: async () => ({ ...withoutModel, serverConfigured: false }) }));
  assert.equal(result.serverConfigured, false);
  await assert.rejects(readRelayStatus({ relay: 'https://attacker.invalid/api/cad-chat' }, undefined, async () => { throw Error('must not fetch'); }), /relay/);
});

test('relay readiness maps network failures safely and propagates cancellation', async () => {
  await assert.rejects(readRelayStatus({}, undefined, async () => { throw new TypeError('network private info'); }), /^Error: cors$/);
  await assert.rejects(readRelayStatus({}, undefined, async () => ({ ok: false, status: 404 })), /relay_missing/);
  const controller = new AbortController();
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(readRelayStatus({}, controller.signal, async () => { throw controller.signal.reason; }), error => error === controller.signal.reason);
});

test('text operations accept single-line Unicode lettering without translating content', () => {
  for (const text of ['Chris', '中文姓名', '👩‍🎨', 'a'.repeat(120), '馬'.repeat(120)]) {
    const op = { op: 'text', at: [10, -20], text, size: 12 };
    assert.deepEqual(parseResponse(JSON.stringify({ reply: 'Lettering prepared.', ops: [op] })).ops, [op]);
  }
  for (const text of ['', '   ', 'a'.repeat(121), 'line\nbreak', 'tab\ttext', 'control\u0000', 'separator\u2028text', 'control\u0085']) {
    assert.throws(() => parseResponse(JSON.stringify({ reply: 'Lettering prepared.', ops: [{ op: 'text', at: [0, 0], text, size: 10 }] })), /invalid/);
  }
  for (const changed of [{ size: 0 }, { size: -1 }, { size: 1e6 + 1 }, { size: '10' }, { at: [1e7, 0] }, { at: [0] }]) {
    assert.throws(() => parseResponse(JSON.stringify({ reply: 'Lettering prepared.', ops: [{ op: 'text', at: [0, 0], text: 'Chris', size: 10, ...changed }] })), /invalid/);
  }
});

test('agent prompt supports stylized animals and editable names instead of primitive-limit refusal', async () => {
  await askAgent({ mode: 'server' }, { ...task('en'), question: 'Draw a horse and my name Chris' }, undefined, async (_url, options) => {
    const system = JSON.parse(options.body).messages[0].content;
    assert.match(system, /stylized vector approximations of animals/);
    assert.match(system, /Do not refuse such designs merely because primitives are limited/);
    assert.match(system, /text operation for names and lettering/);
    assert.match(system, /not outlined cutting paths/);
    return response(JSON.stringify({ reply: 'Stylized horse and editable name prepared.', ops: [{ op: 'text', at: [0, 0], text: 'Chris', size: 10 }] }));
  });
});

test('text dialog has accessible controls, single-line bounds, and bilingual export guidance', () => {
  for (const id of ['text-dialog', 'text-form', 'text-title', 'text-content', 'text-size', 'text-error', 'text-close', 'text-cancel']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /id="text-content"[^>]*maxlength="120"/);
  assert.match(html, /data-tool="text"/);
  setLanguage('zh');
  assert.equal(t('Text'), '文字');
  assert.equal(t('Text exports as editable text, not outlined cutting paths.'), '文字导出为可编辑文本，而非用于切割的轮廓路径。');
  setLanguage('en');
});


test('editable text dimensions preserve English size schema and translate only the UI', () => {
  const op = { op: 'set_dimension', id: 'e1', dimension: 'size', value: 20 };
  assert.deepEqual(parseResponse(JSON.stringify({ reply: 'Font size prepared.', ops: [op] })).ops, [op]);
  setLanguage('zh'); assert.equal(t('e1 size = 20 mm'), 'e1 字号 = 20 毫米'); setLanguage('en');
});

test('workflow UI literals have bilingual coverage without exposing raw preflight codes', () => {
  const workflow = readFileSync(new URL('../js/workflow.mjs', import.meta.url), 'utf8');
  for (const [, key] of workflow.matchAll(/\bt\('([^']+)'/g)) {
    if (key === 'check.' || key === 'severity.') continue; // Runtime suffixes checked below.
    assert.ok(Object.hasOwn(catalogs.en, key), `Missing English workflow text: ${key}`);
    assert.ok(Object.hasOwn(catalogs.zh, key), `Missing Chinese workflow text: ${key}`);
  }
  const preflight = readFileSync(new URL('../js/preflight.mjs', import.meta.url), 'utf8');
  for (const [, code] of preflight.matchAll(/\badd\('([^']+)'/g)) {
    for (const lang of ['en', 'zh']) {
      setLanguage(lang);
      assert.ok(Object.hasOwn(catalogs[lang], 'check.' + code), `Missing ${lang} check: ${code}`);
      assert.notEqual(t('check.' + code), 'check.' + code);
    }
  }
  for (const level of ['error', 'warning', 'info']) for (const lang of ['en', 'zh']) {
    assert.ok(Object.hasOwn(catalogs[lang], 'severity.' + level));
  }
  setLanguage('en');
});

test('workflow generated timeline text translates only bounded known labels', () => {
  setLanguage('zh');
  assert.equal(t('closed path 14 points'), '闭合路径 14 个点');
  assert.equal(t('open path 2 points'), '开放路径 2 个点');
  assert.equal(t('update e18 metadata'), '更新 e18 属性');
  for (const untouched of ['update my-piece metadata', 'open path arbitrary points', 'My closed path 14 points', 'shirt-cut-A', '胸围 98 cm']) {
    assert.equal(t(untouched), untouched);
  }
  assert.equal(t('cut'), '切割');
  assert.equal(t('engrave'), '雕刻');
  assert.equal(t('reference'), '参考');
  setLanguage('en');
  assert.equal(t('closed path 14 points'), 'closed path 14 points');
  assert.equal(t('update e18 metadata'), 'update e18 metadata');
  assert.ok(Object.isFrozen(catalogs.en));
  assert.ok(Object.isFrozen(catalogs.zh));
});

test('reference scale and fabrication limitations are translated with their meaning intact', async () => {
  const { preflight } = await import('../js/preflight.mjs');
  setLanguage('zh');
  for (const key of preflight({ entities: [] }).limitations) {
    assert.ok(Object.hasOwn(catalogs.zh, key), `Missing limitation: ${key}`);
    assert.notEqual(t(key), key);
  }
  for (const key of [
    'Scale calibrated from a user-confirmed measurement. Perspective is not corrected.',
    'Scale is unverified. Calibrate a known length before using measurements.',
    'Enter the real distance. This rescales only this image and its attached annotations, not existing vector paths.',
    'This is a user-entered reference annotation, not a driving geometry constraint. Drag its label to reposition.',
    'Tap the note position on the image.',
    'Tap two points on the image. Escape cancels.',
  ]) assert.notEqual(t(key), key);
  setLanguage('en');
});
