import test from 'node:test';
import assert from 'node:assert/strict';
import { askAgent, DEFAULTS, RELAY } from '../js/agent.mjs';
import { POST } from '../server/cad-relay-route.ts';
import { CAD_SYSTEM } from '../server/cad-relay-system.mjs';
import { createDoc, serializeScene, applyOps } from '../js/model.mjs';

test('real client and relay contract work together with only a mocked provider', async () => {
  const key = 'sk-contract-test-not-a-real-credential';
  const prior = globalThis.fetch;
  const providerCalls = [];
  const answer = { reply: 'Circle created.', ops: [{ op: 'circle', center: [0, 0], radius: 12 }] };
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    providerCalls.push(body);
    assert.equal(url, DEFAULTS.base + '/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer ' + key);
    assert.ok(body.messages[0].content.startsWith(CAD_SYSTEM)); assert.match(body.messages[0].content,/English/);
    return Response.json({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }] });
  };
  try {
    const doc = createDoc();
    const result = await askAgent({ ...DEFAULTS, key }, {
      question: 'Draw a circle with a 12 mm radius', history: [], scene: serializeScene(doc),
    }, undefined, (url, options) => {
      assert.equal(url, RELAY);
      return POST(new Request(url, { ...options, headers: { ...options.headers, Origin: 'https://zhinii.github.io' } }));
    });
    applyOps(doc, result.ops, 'ai');
    assert.equal(doc.entities[0].r, 12);
    assert.equal(providerCalls.length, 1);
    assert.equal(JSON.stringify(providerCalls).includes(key), false);
  } finally { globalThis.fetch = prior; }
});

test('published HTML and every browser module share one cache-busting release', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
  const html = await read('index.html');
  const version = /src="js\/main\.mjs\?v=([^"]+)"/.exec(html)?.[1];
  assert.ok(version, 'Entry module must have a release version');
  assert.ok(html.includes(`href="style.css?v=${version}"`));
  for (const file of ['js/main.mjs', 'js/dxf.mjs', 'js/spatial.mjs']) {
    for (const match of (await read(file)).matchAll(/from\s+'(\.\/[^']+)'/g)) {
      assert.ok(match[1].endsWith(`?v=${version}`), `${file}: ${match[1]} must use the same release`);
    }
  }
});

test('opening a dimension on pointerdown suppresses the later native canvas focus', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../js/main.mjs', import.meta.url), 'utf8');
  assert.match(source, /if \(box\) \{\s*ev\.preventDefault\(\);\s*if \(!box\.measurement\) \{ openDimension\(box\); return; \}/);
});
