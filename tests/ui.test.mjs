import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as model from '../js/model.mjs';
import * as agent from '../js/agent.mjs';
import * as dxf from '../js/dxf.mjs';

// DOM contract/event regression harness, not a browser or layout/focus-trap test.
// Production code is unchanged. Test-only read access is appended in a VM copy.
class Element {
  constructor(tag = 'div', attrs = {}, document) {
    this.tagName = tag.toUpperCase(); this.attrs = attrs; this.ownerDocument = document;
    this.id = attrs.id; this.dataset = {}; this.children = []; this.listeners = new Map();
    this.value = ''; this.hidden = 'hidden' in attrs; this.inert = 'inert' in attrs;
    this.disabled = false; this.checked = false; this.open = false; this._text = '';
    this.className = attrs.class || ''; this.captures = new Set();
    this.clientWidth = 1000; this.clientHeight = 700;
    for (const [key, value] of Object.entries(attrs)) if (key.startsWith('data-')) this.dataset[key.slice(5)] = value;
    this.classList = { contains: name => this.className.split(/\s+/).includes(name),
      add: name => { if (!this.classList.contains(name)) this.className += ' ' + name; },
      toggle: (name, force) => { const on = force ?? !this.classList.contains(name); this.className = this.className.split(/\s+/).filter(n => n !== name).join(' '); if (on) this.classList.add(name); return on; } };
  }
  addEventListener(type, callback) { const list = this.listeners.get(type) || []; list.push(callback); this.listeners.set(type, list); }
  dispatch(type, props = {}) {
    const ev = { type, target: this, button: 0, preventDefault() { this.defaultPrevented = true; }, defaultPrevented: false, ...props };
    const results = []; let target = this;
    do { for (const fn of target.listeners.get(type) || []) results.push(fn(ev)); target = props.bubbles === false ? null : target.parent; } while (target);
    return Promise.all(results);
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  contains(target) { return target === this || this.children.some(c => c.contains(target)); }
  closest(selector) { return /input|textarea|select/.test(selector) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(this.tagName) ? this : null; }
  focus() { this.ownerDocument.activeElement = this; }
  select() { this.selected = true; }
  showModal() { this.open = true; this.modalCalls = (this.modalCalls || 0) + 1; }
  close() { if (!this.open) return; this.open = false; this.dispatch('close', { bubbles: false }); }
  // Browser-native cancel/Escape default action, deliberately modeled rather than claimed verified.
  nativeEscape() { const ev = { type: 'cancel', target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; for (const fn of this.listeners.get('cancel') || []) fn(ev); if (!ev.defaultPrevented) this.close(); }
  getBoundingClientRect() { return this.tagName === 'DIALOG' ? { left: 100, top: 100, right: 700, bottom: 600 } : { left: 0, top: 0, right: 1000, bottom: 700 }; }
  getContext() { return new Proxy({}, { get: (target, key) => target[key] ?? (key === 'measureText' ? text => ({ width: text.length * 7 }) : () => {}), set: (target, key, value) => (target[key] = value, true) }); }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  set innerHTML(value) { assert.equal(value, ''); this.children = []; this._text = ''; }
}
function setup() {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const document = new Element('document'); document.ownerDocument = document; document.activeElement = document;
  const elements = [], ids = new Map(), stack = [document];
  for (const token of html.matchAll(/<!--[^]*?-->|<![^>]*>|<\/([\w-]+)\s*>|<([\w-]+)([^>]*?)>|([^<]+)/g)) {
    if (token[1]) { if (stack.at(-1).tagName === token[1].toUpperCase()) stack.pop(); }
    else if (token[2]) {
      const attrs = {}; for (const attr of token[3].matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[attr[1]] = attr[2] ?? attr[3] ?? attr[4] ?? '';
      const el = new Element(token[2], attrs, document); stack.at(-1).append(el); elements.push(el); if (el.id) ids.set(el.id, el);
      if (!['META', 'LINK', 'INPUT', 'BR', 'HR', 'IMG'].includes(el.tagName)) stack.push(el);
    } else if (token[4]) stack.at(-1)._text += token[4];
  }
  document.getElementById = id => { assert.ok(ids.has(id), `Missing HTML element: ${id}`); return ids.get(id); };
  document.querySelectorAll = selector => selector === '#draw-tools .tool' ? elements.filter(e => e.dataset.tool) : [];
  document.querySelector = selector => selector === 'dialog[open]' ? elements.find(e => e.tagName === 'DIALOG' && e.open) || null : null;
  document.createElement = tag => new Element(tag, {}, document);
  document.createTextNode = text => { const el = new Element('#text', {}, document); el.textContent = text; return el; };
  const window = new Element('window', {}, document); window.matchMedia = () => ({ matches: false });
  const storageCalls = [];
  const storage = { removeItem: key => storageCalls.push(['remove', key]), setItem: (...args) => { storageCalls.push(['set', ...args]); } };
  const requests = [];
  const fetcher = (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
  const context = vm.createContext({ ...model, ...agent, ...dxf, askAgent: (config, task, signal) => agent.askAgent(config, task, signal, fetcher), document, window, localStorage: storage, sessionStorage: storage,
    AbortController, URL, console, requestAnimationFrame: fn => fn(), ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { this.fn(); } } });
  const source = readFileSync(new URL('../js/main.mjs', import.meta.url), 'utf8').replace(/^import[^]*?from\s+'[^']+';\s*/gm, '');
  vm.runInContext(source + '\n globalThis.inspect = () => ({ doc, view, tool, pending, undoStack, redoStack, dimBoxes, connection, activeRequest, history, connState });', context, { filename: 'main.mjs' });
  const el = id => document.getElementById(id);
  const click = async id => { el(id).focus(); await el(id).dispatch('click'); };
  const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const respond = async (index, result = { reply: 'Done', ops: [] }, status = 200) => { requests[index].resolve({ ok: status < 400, status, json: async () => ({ choices: [{ message: { content: JSON.stringify(result) } }] }) }); await tick(); };
  const submit = (id, value) => { el(id === 'chat-form' ? 'chat-input' : 'dim-edit').value = value; return el(id).dispatch('submit'); };
  const pointer = (type, x, y, extra = {}) => el('canvas').dispatch(type, { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', ...extra });
  const tap = async (x, y, extra = {}) => { await pointer('pointerdown', x, y, extra); await pointer('pointerup', x, y, extra); };
  const tool = async name => elements.find(e => e.dataset.tool === name).dispatch('click');
  const connect = async () => { await submit('chat-form', 'sk-testdummy12345'); await respond(requests.length - 1); assert.equal(context.inspect().connState, 'on'); };
  return { el, click, document, window, html, storageCalls, requests, respond, submit, pointer, tap, tool, connect, tick, state: context.inspect, log: () => el('chat-log').textContent };
}

test('startup HTML IDs, offline canvas, accessible dialog controls, and no persistent keys', () => {
  const h = setup(); assert.equal(h.state().doc.entities.length, 0); assert.equal(h.state().tool, 'select');
  assert.equal(h.el('undo').disabled, true); assert.equal(h.el('redo').disabled, true);
  assert.match(h.log(), /VectorForge ready/); assert.equal(h.requests.length, 0);
  for (const id of ['settings-close', 'settings-cancel', 'dimension-close', 'dimension-cancel']) assert.equal(h.el(id).getAttribute('type'), 'button');
  assert.equal(h.el('settings-dialog').tagName, 'DIALOG'); assert.equal(h.el('dimension-dialog').tagName, 'DIALOG');
  assert.equal(h.el('set-key').getAttribute('type'), 'password'); assert.equal(h.el('set-key').getAttribute('autocomplete'), 'off');
  assert.deepEqual(h.storageCalls, [['remove', 'vectorforge.connection'], ['remove', 'vectorforge.connection']]);
});

test('settings X, Cancel, backdrop, native Escape contract, focus return, key clearing', async () => {
  const h = setup(), dlg = h.el('settings-dialog');
  for (const exit of ['settings-close', 'settings-cancel', 'backdrop', 'escape']) {
    await h.click('settings-btn'); assert.equal(dlg.open, true); assert.equal(h.document.activeElement.id, 'settings-close');
    h.el('set-key').value = 'sk-private12345';
    if (exit === 'backdrop') { await dlg.dispatch('pointerdown', { clientX: 10, clientY: 10 }); await dlg.dispatch('click', { clientX: 10, clientY: 10 }); }
    else if (exit === 'escape') dlg.nativeEscape(); else await h.click(exit);
    assert.equal(dlg.open, false); assert.equal(h.el('set-key').value, ''); assert.equal(h.document.activeElement.id, 'settings-btn');
  }
  assert.equal(dlg.modalCalls, 4); assert.equal(h.requests.length, 0);
  await h.click('settings-btn'); await dlg.dispatch('pointerdown', { clientX: 120, clientY: 120 }); await dlg.dispatch('click', { clientX: 120, clientY: 120 }); assert.equal(dlg.open, true);
  await h.el('settings-form').dispatch('submit'); assert.equal(dlg.open, true); assert.equal(h.el('settings-error').hidden, false); assert.match(h.el('settings-error').textContent, /key/);
});

test('timeline is initially inert and closes by X, toggle, outside, Escape or opening a dialog', async () => {
  const h = setup(), panel = h.el('timeline-panel'); assert.equal(panel.inert, true); assert.equal(panel.getAttribute('aria-hidden'), 'true');
  for (const exit of ['timeline-close', 'timeline-toggle', 'outside', 'escape', 'dialog']) {
    await h.click('timeline-toggle'); assert.equal(panel.inert, false); assert.equal(h.el('timeline-toggle').getAttribute('aria-expanded'), 'true'); assert.equal(h.document.activeElement.id, 'timeline-close');
    if (exit === 'outside') await h.el('canvas').dispatch('pointerdown', { clientX: 1, clientY: 1, pointerId: 3, pointerType: 'mouse' });
    else if (exit === 'escape') await h.window.dispatch('keydown', { key: 'Escape', target: panel });
    else if (exit === 'dialog') await h.click('settings-btn'); else await h.click(exit);
    assert.equal(panel.inert, true); assert.equal(panel.getAttribute('aria-hidden'), 'true'); assert.equal(h.el('timeline-toggle').getAttribute('aria-expanded'), 'false');
  }
});

test('pointer draw, undo/redo buttons and keyboard form one deterministic history', async () => {
  const h = setup(); await h.tool('line'); await h.tap(500, 350); assert.ok(h.state().pending); await h.tap(540, 350);
  assert.equal(h.state().doc.entities.length, 1); assert.equal(h.state().undoStack.length, 1); assert.equal(h.el('undo').disabled, false);
  await h.click('undo'); assert.equal(h.state().doc.entities.length, 0); assert.equal(h.el('redo').disabled, false);
  await h.click('redo'); assert.equal(h.state().doc.entities.length, 1);
  await h.window.dispatch('keydown', { key: 'z', ctrlKey: true, target: h.el('canvas') }); assert.equal(h.state().doc.entities.length, 0);
  await h.window.dispatch('keydown', { key: 'y', ctrlKey: true, target: h.el('canvas') }); assert.equal(h.state().doc.entities.length, 1);
  await h.window.dispatch('keydown', { key: 'z', ctrlKey: true, target: h.el('chat-input') }); assert.equal(h.state().doc.entities.length, 1);
});

test('dimension editor applies exactly once; blur, duplicate submit and cancellation do not apply', async () => {
  const h = setup(); await h.tool('circle'); await h.tap(500, 350); await h.tap(540, 350); await h.tool('select');
  const open = async () => { const box = h.state().dimBoxes[0]; await h.tap(box.x + 2, box.y + 2); assert.equal(h.el('dimension-dialog').open, true); };
  await open(); await h.submit('dimension-form', '20'); await h.el('dim-edit').dispatch('blur'); await h.el('dimension-form').dispatch('submit');
  assert.equal(h.state().doc.entities[0].r, 20); assert.equal(h.state().undoStack.length, 2); assert.equal(h.state().doc.timeline.length, 2); assert.equal(h.el('dimension-dialog').open, false);
  await open(); await h.submit('dimension-form', '-2'); assert.equal(h.el('dimension-error').hidden, false); assert.equal(h.el('dimension-dialog').open, true); assert.equal(h.state().doc.entities[0].r, 20);
  await h.click('dimension-cancel'); await open(); h.el('dim-edit').value = '30'; h.el('dimension-dialog').nativeEscape(); assert.equal(h.state().doc.entities[0].r, 20);
  await open(); h.el('dim-edit').value = '40'; await h.click('dimension-close'); assert.equal(h.state().undoStack.length, 2); assert.equal(h.document.activeElement.id, 'canvas');
});

test('two-touch pinch zooms without geometry or undo entries; canceled pointers never draw', async () => {
  const h = setup(); await h.tool('line'); const before = JSON.stringify(h.state().doc.entities);
  await h.pointer('pointerdown', 450, 350, { pointerType: 'touch', pointerId: 1 });
  await h.pointer('pointerdown', 550, 350, { pointerType: 'touch', pointerId: 2 });
  await h.pointer('pointermove', 580, 350, { pointerType: 'touch', pointerId: 2 });
  await h.pointer('pointerup', 450, 350, { pointerType: 'touch', pointerId: 1 }); await h.pointer('pointerup', 580, 350, { pointerType: 'touch', pointerId: 2 });
  assert.ok(h.state().view.s > 4); assert.equal(JSON.stringify(h.state().doc.entities), before); assert.equal(h.state().pending, null); assert.equal(h.state().undoStack.length, 0);
  await h.pointer('pointerdown', 300, 300); await h.pointer('pointercancel', 300, 300); assert.equal(h.state().pending, null);
});

test('connect through API form and design success are transient, transactional and undoable', async () => {
  const h = setup(); await h.click('settings-btn'); h.el('set-key').value = 'sk-testdummy12345'; await h.el('settings-form').dispatch('submit');
  assert.equal(h.state().connState, 'checking'); assert.equal(h.el('settings-dialog').open, false); assert.equal(h.el('set-key').value, '');
  assert.equal(h.requests[0].options.headers.Authorization, 'Bearer sk-testdummy12345'); assert.equal(h.requests[0].options.credentials, 'omit');
  await h.respond(0); assert.equal(h.state().connState, 'on');
  const done = h.submit('chat-form', 'draw a 10mm circle'); assert.equal(h.el('cancel-request').hidden, false); assert.equal(h.el('send-btn').disabled, true);
  await h.respond(1, { reply: 'Circle created', ops: [{ op: 'circle', center: [0, 0], radius: 10 }] }); await done;
  assert.equal(h.state().doc.entities[0].r, 10); assert.equal(h.state().history.length, 2); assert.equal(h.el('send-btn').disabled, false); assert.equal(h.el('cancel-request').hidden, true);
  await h.click('undo'); assert.equal(h.state().doc.entities.length, 0); await h.click('redo'); assert.equal(h.state().doc.entities.length, 1);
  assert.ok(h.storageCalls.every(([action]) => action === 'remove')); assert.doesNotMatch(h.log(), /sk-testdummy12345/);
  await h.click('settings-btn'); await h.click('settings-disconnect'); assert.equal(h.state().connection.key, ''); assert.equal(h.state().connState, 'off');
});

test('connect and design auth failures surface actionable errors and always clear busy state', async () => {
  const h = setup(); await h.submit('chat-form', 'sk-testdummy12345'); await h.respond(0, {}, 401); assert.equal(h.state().connState, 'error'); assert.match(h.log(), /key was rejected/); assert.equal(h.el('send-btn').disabled, false);
  await h.connect(); const done = h.submit('chat-form', 'circle'); await h.respond(2, {}, 403); await done;
  assert.equal(h.state().connState, 'error'); assert.equal(h.state().doc.entities.length, 0); assert.equal(h.state().history.length, 0); assert.equal(h.el('cancel-request').hidden, true);
});

test('Stop aborts design request and ignores even a late successful fetch', async () => {
  const h = setup(); await h.connect(); const done = h.submit('chat-form', 'circle'); await h.click('cancel-request'); assert.equal(h.requests[1].options.signal.aborted, true);
  await h.respond(1, { reply: 'Late', ops: [{ op: 'circle', center: [0, 0], radius: 10 }] }); await done;
  assert.equal(h.state().doc.entities.length, 0); assert.equal(h.state().history.length, 0); assert.doesNotMatch(h.log(), /Late/); assert.equal(h.el('send-btn').disabled, false);
});

test('new key supersedes connection attempt and old result cannot replace newer state', async () => {
  const h = setup(); await h.submit('chat-form', 'sk-firstdummy12345'); await h.submit('chat-form', 'sk-seconddummy12345');
  assert.equal(h.requests[0].options.signal.aborted, true); await h.respond(1); await h.respond(0, {}, 401);
  assert.equal(h.state().connState, 'on'); assert.equal(h.state().connection.key, 'sk-seconddummy12345'); assert.doesNotMatch(h.log(), /firstdummy|seconddummy|Connection test failed/);
});

test('manual geometry edits abort pending AI and stale selection response is rejected', async () => {
  const h = setup(); await h.connect(); let done = h.submit('chat-form', 'circle'); await h.tool('line'); await h.tap(500, 350); await h.tap(540, 350);
  assert.equal(h.requests[1].options.signal.aborted, true); await h.respond(1, { reply: 'Late', ops: [{ op: 'clear' }] }); await done; assert.equal(h.state().doc.entities.length, 1);
  done = h.submit('chat-form', 'make selected bigger'); await h.tool('select'); await h.tap(100, 100); assert.equal(h.state().doc.selectedId, null);
  await h.respond(2, { reply: 'Stale', ops: [{ op: 'clear' }] }); await done;
  assert.equal(h.state().doc.entities.length, 1); assert.match(h.log(), /selection or drawing changed/); assert.doesNotMatch(h.log(), /Stale/);
});

test('invalid AI operations leave geometry and undo history untouched', async () => {
  const h = setup(); await h.connect(); const done = h.submit('chat-form', 'bad operation');
  await h.respond(1, { reply: 'Should not succeed', ops: [{ op: 'circle', center: [0, 0], radius: 10 }, { op: 'delete', id: 'missing' }] }); await done;
  assert.equal(h.state().doc.entities.length, 0); assert.equal(h.state().undoStack.length, 0); assert.equal(h.state().history.length, 0); assert.doesNotMatch(h.log(), /Should not succeed/); assert.match(h.log(), /Nothing was applied/); assert.equal(h.el('send-btn').disabled, false);
});

test('embedded secrets are neither echoed nor sent; provider reply keys are redacted', async () => {
  const h = setup(); await h.submit('chat-form', 'use sk-private12345 to draw'); assert.equal(h.requests.length, 0); assert.doesNotMatch(h.log(), /sk-private12345/);
  await h.connect(); const done = h.submit('chat-form', 'say hello'); await h.respond(1, { reply: 'Secret sk-testdummy12345', ops: [] }); await done;
  assert.doesNotMatch(h.log(), /sk-testdummy12345/); assert.match(h.log(), /\[redacted\]/); assert.ok(h.storageCalls.every(([action]) => action === 'remove'));
});

test('open modal blocks canvas creation and global drawing/delete/undo shortcuts', async () => {
  const h = setup(); await h.tool('circle'); await h.tap(500, 350); await h.tap(540, 350); await h.click('settings-btn');
  const before = JSON.stringify(h.state().doc.entities);
  await h.tap(800, 600); await h.tap(850, 600);
  for (const key of ['Delete', 'l', 'z']) await h.window.dispatch('keydown', { key, ctrlKey: key === 'z', target: h.el('canvas') });
  assert.equal(JSON.stringify(h.state().doc.entities), before); assert.equal(h.state().tool, 'circle'); assert.equal(h.state().pending, null);
});

test('center grip drag is movable, records a single undo and touch pinch leaves existing geometry intact', async () => {
  const h = setup(); await h.tool('circle'); await h.tap(500, 350); await h.tap(540, 350); await h.tool('select');
  await h.pointer('pointerdown', 500, 350); await h.pointer('pointermove', 520, 350); await h.pointer('pointermove', 540, 350); await h.pointer('pointerup', 540, 350);
  assert.equal(h.state().doc.entities[0].c[0], 10); assert.equal(h.state().doc.entities[0].r, 10); assert.equal(h.state().undoStack.length, 2);
  await h.click('undo'); assert.equal(h.state().doc.entities[0].c[0], 0);
  const before = JSON.stringify(h.state().doc.entities), undoCount = h.state().undoStack.length;
  await h.pointer('pointerdown', 500, 350, { pointerType: 'touch', pointerId: 1 }); await h.pointer('pointerdown', 600, 350, { pointerType: 'touch', pointerId: 2 });
  await h.pointer('pointermove', 630, 350, { pointerType: 'touch', pointerId: 2 }); await h.pointer('pointermove', 510, 350, { pointerType: 'touch', pointerId: 1 });
  await h.pointer('pointerup', 630, 350, { pointerType: 'touch', pointerId: 2 }); await h.pointer('pointerup', 510, 350, { pointerType: 'touch', pointerId: 1 });
  assert.equal(JSON.stringify(h.state().doc.entities), before); assert.equal(h.state().undoStack.length, undoCount);
});

test('superseded design failure cannot overwrite newer connection or clear its busy indicator', async () => {
  const h = setup(); await h.connect(); const old = h.submit('chat-form', 'circle'); await h.submit('chat-form', 'sk-newdummy12345');
  assert.equal(h.requests[1].options.signal.aborted, true); h.requests[1].reject(new TypeError('Canceled fetch')); await h.tick(); await old;
  assert.equal(h.state().connState, 'checking'); assert.equal(h.el('send-btn').disabled, true); assert.equal(h.el('cancel-request').hidden, false);
  await h.respond(2); assert.equal(h.state().connState, 'on'); assert.equal(h.el('send-btn').disabled, false); assert.doesNotMatch(h.log(), /Cannot reach|key was rejected/);
});

test('connection Stop ignores late response and leaves key nonpersistent', async () => {
  const h = setup(); await h.submit('chat-form', 'sk-testdummy12345'); await h.click('cancel-request');
  assert.equal(h.state().connState, 'off'); assert.equal(h.requests[0].options.signal.aborted, true); await h.respond(0);
  assert.equal(h.state().connState, 'off'); assert.equal(h.state().activeRequest, null); assert.doesNotMatch(h.log(), /Connected to/); assert.equal(h.el('send-btn').disabled, false);
});

test('network retries produce actionable UI error without leaking transport details', async () => {
  const h = setup(); await h.submit('chat-form', 'sk-testdummy12345');
  h.requests[0].reject(new TypeError('secret sk-testdummy12345')); await h.tick(); assert.equal(h.requests.length, 2);
  h.requests[1].reject(new TypeError('secret sk-testdummy12345')); await h.tick();
  assert.equal(h.state().connState, 'error'); assert.match(h.log(), /Cannot reach the relay or provider/); assert.doesNotMatch(h.log(), /sk-testdummy12345/); assert.equal(h.el('send-btn').disabled, false);
});

test('relay-origin rejection is distinct from a rejected API key', async () => {
  const h = setup(); await h.submit('chat-form', 'sk-testdummy12345');
  h.requests[0].resolve({ ok: false, status: 403, json: async () => ({ error: 'origin' }) }); await h.tick();
  assert.match(h.log(), /rejected this website origin/); assert.doesNotMatch(h.log(), /API key was rejected/); assert.equal(h.state().connState, 'error');
});
