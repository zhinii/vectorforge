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
    assert.equal(body.messages[0].content, CAD_SYSTEM);
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
