import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as model from '../js/model.mjs';
import * as agent from '../js/agent.mjs';
import * as dxf from '../js/dxf.mjs';
import * as i18n from '../js/i18n.mjs';
import * as spatial from '../js/spatial.mjs';
import {initWorkflow} from '../js/workflow.mjs';

// DOM contract/event regression harness, not a browser or layout/focus-trap test.
// Production code is unchanged. Test-only read access is appended in a VM copy.
class Element {
  constructor(tag = 'div', attrs = {}, document) {
    this.tagName = tag.toUpperCase(); this.attrs = attrs; this.ownerDocument = document;
    this.id = attrs.id; this.dataset = {}; this.children = []; this.listeners = new Map();
    this.style = { values: {}, setProperty(name, value) { this.values[name] = value; } };
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
  focus(options) { this.focusOptions = options; this.ownerDocument.activeElement = this; }
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
function setup({ deferredHealth = false, quickTimeout = false } = {}) {
  i18n.setLanguage('en');
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
  document.getElementById = id => { const find = e => e.id===id?e:e.children.map(find).find(Boolean); const result=ids.get(id)||find(document); assert.ok(result, `Missing HTML element: ${id}`); return result; };
  document.querySelectorAll = selector => selector === '#draw-tools .tool' ? elements.filter(e => e.dataset.tool) : selector === '[data-workshop]' ? elements.filter(e=>e.dataset.workshop) : /^\[data-i18n[^\]]*\]$/.test(selector) ? elements.filter(e => e.getAttribute(selector.slice(1,-1)) !== null) : [];
  document.querySelector = selector => selector === 'dialog[open]' ? elements.find(e => e.tagName === 'DIALOG' && e.open) || null : null;
  document.createElement = tag => new Element(tag, {}, document);
  document.createTextNode = text => { const el = new Element('#text', {}, document); el.textContent = text; return el; };
  document.documentElement = elements.find(e => e.tagName === 'HTML');
  const window = new Element('window', {}, document); window.Image=class {set src(value){this._src=value;this.naturalWidth=100;this.naturalHeight=100;} get src(){return this._src;}};
  window.innerWidth = 1000; window.innerHeight = 700;
  window.visualViewport = Object.assign(new Element('viewport', {}, document), { width: 1000, height: 700, offsetLeft: 0, offsetTop: 0 });
  window.matchMedia = () => ({ matches: false });
  const storageCalls = [];
  const storage = { removeItem: key => storageCalls.push(['remove', key]), setItem: (...args) => { storageCalls.push(['set', ...args]); } };
  const requests = [];
  const healthCalls = [];
  const healthResult = (status=200,configured=true) => ({ok:status<400,status,json:async()=>({service:'VectorForge CAD connection',configured:true,auth:'server+byok',defaultMode:'server',serverConfigured:configured,serverModel:'qwen3.8-flash',version:2})});
  const fetcher = (url, options) => { if (options.method === 'GET') {
    if (!deferredHealth) {healthCalls.push({url,options});return Promise.resolve(healthResult());}
    return new Promise((resolve,reject)=>{healthCalls.push({url,options,resolve,reject});options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});
  } return new Promise((resolve,reject)=>requests.push({url,options,resolve,reject})); };
  const context = vm.createContext({ initWorkflow, structuredClone, ...model, ...agent, ...dxf, ...i18n, ...spatial, readRelayStatus:(config,signal)=>agent.readRelayStatus(config,signal,fetcher), askAgent: (config, task, signal) => agent.askAgent(config, task, signal, fetcher), document, window, localStorage: storage, sessionStorage: storage,
    AbortController, URL, console, setTimeout:(fn,ms)=>setTimeout(fn,quickTimeout && ms===10000 ? 1 : ms), clearTimeout, requestAnimationFrame: fn => fn(), ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { this.fn(); } } });
  const source = readFileSync(new URL('../js/main.mjs', import.meta.url), 'utf8').replace(/^import[^]*?from\s+'[^']+';\s*/gm, '');
  vm.runInContext(source + '\n globalThis.inspect = () => ({ doc, view, tool, pending, undoStack, redoStack, dimBoxes, connection, activeRequest, history, connState, clipboard, snapEnabled, snapTarget, labelOffsets, selectedMeasurement, measurementsEnabled, workflow });', context, { filename: 'main.mjs' });
  const el = id => document.getElementById(id);
  const click = async id => { el(id).focus(); await el(id).dispatch('click'); };
  const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const respond = async (index, result = { reply: 'Done', ops: [] }, status = 200) => { requests[index].resolve({ ok: status < 400, status, json: async () => ({ choices: [{ message: { content: JSON.stringify(result) } }] }) }); await tick(); };
  const submit = (id, value) => { el(id === 'chat-form' ? 'chat-input' : 'dim-edit').value = value; return el(id).dispatch('submit'); };
  const pointer = (type, x, y, extra = {}) => el('canvas').dispatch(type, { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', ...extra });
  const tap = async (x, y, extra = {}) => { await pointer('pointerdown', x, y, extra); await pointer('pointerup', x, y, extra); };
  const tool = async name => elements.find(e => e.dataset.tool === name).dispatch('click');
  const connect = async () => { await submit('chat-form', 'sk-testdummy12345'); await respond(requests.length - 1); assert.equal(context.inspect().connState, 'on'); };
  return { el, click, document, window, html, storageCalls, healthCalls, healthResult, requests, respond, submit, pointer, tap, tool, connect, tick, state: context.inspect, log: () => el('chat-log').textContent };
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
    await h.click('conn-light'); assert.equal(dlg.open, true); assert.equal(h.document.activeElement.id, 'settings-close');
    h.el('set-key').value = 'sk-private12345';
    if (exit === 'backdrop') { await dlg.dispatch('pointerdown', { clientX: 10, clientY: 10 }); await dlg.dispatch('click', { clientX: 10, clientY: 10 }); }
    else if (exit === 'escape') dlg.nativeEscape(); else await h.click(exit);
    assert.equal(dlg.open, false); assert.equal(h.el('set-key').value, ''); assert.equal(h.document.activeElement.id, 'conn-light');
  }
  assert.equal(dlg.modalCalls, 4); assert.equal(h.requests.length, 0);
  await h.click('conn-light'); await dlg.dispatch('pointerdown', { clientX: 120, clientY: 120 }); await dlg.dispatch('click', { clientX: 120, clientY: 120 }); assert.equal(dlg.open, true);
  h.el('set-mode').value='byok'; await h.el('settings-form').dispatch('submit'); assert.equal(dlg.open, true); assert.equal(h.el('settings-error').hidden, false); assert.match(h.el('settings-error').textContent, /key/);
});

test('timeline is initially inert and closes by X, toggle, outside, Escape or opening a dialog', async () => {
  const h = setup(), panel = h.el('timeline-panel'); assert.equal(panel.inert, true); assert.equal(panel.getAttribute('aria-hidden'), 'true');
  for (const exit of ['timeline-close', 'timeline-toggle', 'outside', 'escape', 'dialog']) {
    await h.click('timeline-toggle'); assert.equal(panel.inert, false); assert.equal(h.el('timeline-toggle').getAttribute('aria-expanded'), 'true'); assert.equal(h.document.activeElement.id, 'timeline-close');
    if (exit === 'outside') await h.el('canvas').dispatch('pointerdown', { clientX: 1, clientY: 1, pointerId: 3, pointerType: 'mouse' });
    else if (exit === 'escape') await h.window.dispatch('keydown', { key: 'Escape', target: panel });
    else if (exit === 'dialog') await h.click('conn-light'); else await h.click(exit);
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
  const h = setup(); await h.click('conn-light'); h.el('set-mode').value='byok'; h.el('set-key').value = 'sk-testdummy12345'; await h.el('settings-form').dispatch('submit');
  assert.equal(h.state().connState, 'checking'); assert.equal(h.el('settings-dialog').open, false); assert.equal(h.el('set-key').value, '');
  assert.equal(h.requests[0].options.headers.Authorization, 'Bearer sk-testdummy12345'); assert.equal(h.requests[0].options.credentials, 'omit');
  await h.respond(0); assert.equal(h.state().connState, 'on');
  const done = h.submit('chat-form', 'draw a 10mm circle'); assert.equal(h.el('cancel-request').hidden, false); assert.equal(h.el('send-btn').disabled, true);
  await h.respond(1, { reply: 'Circle created', ops: [{ op: 'circle', center: [0, 0], radius: 10 }] }); await done;
  assert.equal(h.state().doc.entities[0].r, 10); assert.equal(h.state().history.length, 2); assert.equal(h.el('send-btn').disabled, false); assert.equal(h.el('cancel-request').hidden, true);
  await h.click('undo'); assert.equal(h.state().doc.entities.length, 0); await h.click('redo'); assert.equal(h.state().doc.entities.length, 1);
  assert.ok(h.storageCalls.every(([action]) => action === 'remove')); assert.doesNotMatch(h.log(), /sk-testdummy12345/);
  await h.click('conn-light'); await h.click('settings-disconnect'); assert.equal(h.state().connection.key, ''); assert.equal(h.state().connState, 'off');
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

test('manual geometry edits abort pending AI but selection-only changes preserve submitted target', async () => {
  const h = setup(); await h.connect(); let done = h.submit('chat-form', 'circle'); await h.tool('line'); await h.tap(500, 350); await h.tap(540, 350);
  assert.equal(h.requests[1].options.signal.aborted, true); await h.respond(1, { reply: 'Late', ops: [{ op: 'clear' }] }); await done; assert.equal(h.state().doc.entities.length, 1);
  done = h.submit('chat-form', 'make selected bigger'); await h.tool('select'); await h.tap(100, 100); assert.equal(h.state().doc.selectedId, null);
  await h.respond(2, { reply: 'Applied to original scene', ops: [{ op: 'circle', center:[30,0], radius:5 }] }); await done;
  assert.equal(h.state().doc.entities.length, 2); assert.doesNotMatch(h.log(), /selection or drawing changed/); assert.match(h.log(), /Applied to original scene/);
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
  const h = setup(); await h.tool('circle'); await h.tap(500, 350); await h.tap(540, 350); await h.click('conn-light');
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


test('Delete button follows selection, is undo-safe, and shares keyboard behavior', async () => {
  const h = setup(); assert.equal(h.el('delete-selected').disabled, true);
  await h.tool('circle'); await h.tap(500, 350); await h.tap(540, 350);
  assert.equal(h.el('delete-selected').disabled, false);
  const before = JSON.stringify(h.state().doc.entities);
  await h.click('delete-selected'); assert.equal(h.state().doc.entities.length, 0); assert.equal(h.el('delete-selected').disabled, true);
  assert.equal(h.state().undoStack.length, 2);
  await h.click('delete-selected'); assert.equal(h.state().undoStack.length, 2);
  await h.click('undo'); assert.equal(JSON.stringify(h.state().doc.entities), before); assert.equal(h.el('delete-selected').disabled, false);
  await h.window.dispatch('keydown', { key: 'Delete', target: h.el('canvas') });
  assert.equal(h.state().doc.entities.length, 0); await h.click('undo');
  await h.tool('select'); await h.tap(100, 100); assert.equal(h.el('delete-selected').disabled, true);
});

test('canvas touch gestures block native page zoom, but not gestures elsewhere', async () => {
  const h = setup();
  for (const type of ['touchstart', 'touchmove']) {
    let prevented = false;
    await h.el('canvas').dispatch(type, { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    prevented = false;
    await h.el('chat-input').dispatch(type, { preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
  }
});

test('pinch keeps the prior world midpoint anchored under the moving fingers', async () => {
  const h = setup();
  await h.pointer('pointerdown', 400, 300, { pointerType: 'touch', pointerId: 1 });
  await h.pointer('pointerdown', 500, 300, { pointerType: 'touch', pointerId: 2 });
  const v = h.state().view, anchor = [(450-v.ox)/v.s,(v.oy-300)/v.s];
  await h.pointer('pointermove', 550, 320, { pointerType: 'touch', pointerId: 2 });
  assert.ok(Math.abs(v.ox + anchor[0]*v.s - 475) < 1e-9);
  assert.ok(Math.abs(v.oy - anchor[1]*v.s - 310) < 1e-9);
  await h.pointer('pointerup', 400, 300, { pointerType: 'touch', pointerId: 1 });
  await h.pointer('pointerup', 550, 320, { pointerType: 'touch', pointerId: 2 });
});

test('floating panels preserve scene transform and restore focus without scrolling', async () => {
  const h = setup(); await h.tool('circle'); await h.tap(500,350); await h.tap(540,350); await h.tool('select');
  const before = JSON.stringify(h.state().view);
  await h.click('conn-light'); assert.equal(JSON.stringify(h.state().view), before);
  await h.click('settings-close'); assert.equal(JSON.stringify(h.state().view), before);
  assert.equal(h.el('conn-light').focusOptions.preventScroll, true);
  const b = h.state().dimBoxes[0]; await h.tap(b.x+2,b.y+2);
  assert.equal(h.el('dim-edit').focusOptions.preventScroll, true);
  await h.click('dimension-cancel'); assert.equal(JSON.stringify(h.state().view), before);
  assert.equal(h.el('canvas').focusOptions.preventScroll, true);
  await h.click('timeline-toggle'); await h.click('timeline-close'); assert.equal(JSON.stringify(h.state().view), before);
});

test('mobile viewport containment excludes closed drawer without disabling accessible page zoom', () => {
  const h = setup(); const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  assert.match(css, /html, body \{[^}]*width: 100%[^}]*overflow: hidden/s);
  assert.match(css, /#workspace \{[^}]*min-width: 0[^}]*overflow: hidden/s);
  assert.match(css, /#timeline-panel:not\(\.open\) \{ display: none; \}/);
  assert.match(css, /dialog \{\s*position: fixed; inset: auto; margin: 0;/);
  assert.match(css, /\.actions \{ grid-template-columns: repeat\(6, minmax\(0, 1fr\)\); \}/);
  assert.doesNotMatch(h.html, /user-scalable\s*=\s*no|maximum-scale\s*=/i);
});


test('floating API and Timeline remain in the zoomed visual viewport without moving drawing', async () => {
  const h = setup(), vv = h.window.visualViewport, css = h.document.documentElement.style.values;
  const before = JSON.stringify(h.state().view);
  Object.assign(vv, { width: 300, height: 500, offsetLeft: 120, offsetTop: 80 });
  await h.click('conn-light');
  assert.equal(css['--overlay-left'], '270px'); assert.equal(css['--overlay-top'], '330px');
  assert.equal(css['--overlay-width'], '276px'); assert.equal(css['--overlay-height'], '476px');
  vv.height = 250; vv.offsetTop = 180; await vv.dispatch('resize');
  assert.equal(css['--overlay-top'], '305px'); assert.equal(css['--overlay-height'], '226px');
  await h.click('settings-close'); await h.click('timeline-toggle');
  assert.equal(css['--drawer-left'], '132px'); assert.equal(css['--drawer-width'], '276px');
  assert.equal(JSON.stringify(h.state().view), before);
  await h.click('timeline-close'); assert.equal(JSON.stringify(h.state().view), before);
});


test('console shows about eight lines with a short-viewport cap and scrollback', () => {
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  assert.match(css, /#chat-log \{[^}]*height: calc\(1\.5em \* 8 \+ 8px\); max-height: 28dvh; overflow-y: auto;/s);
  assert.doesNotMatch(css, /#chat-log \{ height: calc\(1\.5em \* 3\)/);
});


test('Timeline floats above scene on short zoomed or keyboard viewport to keep list usable', async () => {
  const h = setup(), vv = h.window.visualViewport, css = h.document.documentElement.style.values;
  Object.assign(vv, { width: 393, height: 252, offsetLeft: 0, offsetTop: 0 });
  await h.click('timeline-toggle');
  assert.equal(css['--drawer-top'], '12px');
  assert.equal(css['--drawer-height'], '228px');
});

test('touch Copy/Paste makes detached offset geometry with unique IDs and undo/redo', async () => {
  const h=setup(); assert.equal(h.el('copy-selected').disabled,true); assert.equal(h.el('paste-selected').disabled,true);
  await h.tool('circle'); await h.tap(500,350); await h.tap(540,350);
  const original=JSON.stringify(h.state().doc.entities[0]);
  await h.click('copy-selected'); await h.click('paste-selected');
  let es=h.state().doc.entities;
  assert.equal(es.length,2); assert.notEqual(es[0].id,es[1].id); assert.equal(es[1].r,10);
  assert.deepEqual(Array.from(es[1].c),[6,-6]); assert.equal(JSON.stringify(es[0]),original);
  await h.click('paste-selected'); es=h.state().doc.entities; assert.deepEqual(Array.from(es[2].c),[12,-12]);
  assert.equal(new Set(es.map(e=>e.id)).size,3);
  await h.click('undo'); assert.equal(h.state().doc.entities.length,2);
  await h.click('redo'); assert.equal(h.state().doc.entities.length,3);
  await h.click('delete-selected'); await h.click('paste-selected'); assert.equal(h.state().doc.entities.length,3);
});

test('keyboard Copy/Paste ignores editable fields and does not request system clipboard', async () => {
  const h=setup(); await h.tool('line'); await h.tap(500,350); await h.tap(540,350);
  await h.window.dispatch('keydown',{key:'c',ctrlKey:true,target:h.el('chat-input')}); assert.equal(h.state().clipboard,null);
  await h.window.dispatch('keydown',{key:'c',ctrlKey:true,target:h.el('canvas')});
  await h.window.dispatch('keydown',{key:'v',metaKey:true,target:h.el('chat-input')}); assert.equal(h.state().doc.entities.length,1);
  await h.window.dispatch('keydown',{key:'v',metaKey:true,target:h.el('canvas')}); assert.equal(h.state().doc.entities.length,2);
});

test('line drawing snaps to endpoint and perpendicular foot with visible targets; toggle disables', async () => {
  const h=setup(); await h.tool('line'); await h.tap(500,350); await h.tap(660,350);
  await h.pointer('pointermove',503,352); assert.equal(h.state().snapTarget.kind,'endpoint');
  await h.tap(503,352); assert.deepEqual(Array.from(h.state().pending.start),[0,0]);
  await h.tap(500,430);
  await h.tool('line'); await h.tap(600,430); await h.pointer('pointermove',601,352);
  assert.equal(h.state().snapTarget.kind,'perpendicular'); await h.tap(601,352);
  assert.deepEqual(Array.from(h.state().doc.entities.at(-1).p2),[25,0]);
  await h.click('snap-toggle'); assert.equal(h.state().snapEnabled,false);
  await h.pointer('pointermove',503,352); assert.equal(h.state().snapTarget,null);
  await h.tap(503,352); assert.deepEqual(Array.from(h.state().pending.start),[.75,-.5]);
});

test('nearby measurement labels drag without changing geometry and remain undoable', async () => {
  const h=setup(); await h.tool('line'); await h.tap(400,470); await h.tap(650,470);
  await h.tool('circle'); await h.tap(500,350); await h.tap(540,350); await h.tool('select');
  const b=h.state().dimBoxes.find(b=>b.measurement); assert.ok(b);
  assert.equal(b.measurement.centerDistance,30); assert.equal(b.measurement.clearance,20);
  const before=JSON.stringify(h.state().doc.entities), count=h.state().undoStack.length;
  await h.pointer('pointerdown',b.x+8,b.y+8); await h.pointer('pointermove',b.x+38,b.y+28); await h.pointer('pointerup',b.x+38,b.y+28);
  assert.equal(JSON.stringify(h.state().doc.entities),before); assert.equal(h.state().undoStack.length,count+1);
  assert.ok(h.state().labelOffsets[b.labelKey]); assert.equal(h.el('dimension-dialog').open,false);
  await h.click('undo'); assert.equal(Object.keys(h.state().labelOffsets).length,0);
  await h.click('measurements-toggle'); assert.equal(h.state().dimBoxes.some(b=>b.measurement),false);
});

test('four-point cubic Bezier creates, reshapes, copies and exports through supported model', async () => {
  const h=setup(); await h.tool('bezier');
  for (const p of [[500,350],[520,290],[580,290],[600,350]]) await h.tap(...p);
  let e=h.state().doc.entities[0]; assert.equal(e.type,'bezier'); assert.deepEqual(Array.from(e.c1),[5,15]);
  await h.tool('select'); await h.pointer('pointerdown',520,290); await h.pointer('pointermove',520,270); await h.pointer('pointerup',520,270);
  assert.equal(e.c1[1],20); await h.click('copy-selected'); await h.click('paste-selected');
  e=h.state().doc.entities[1]; assert.equal(e.type,'bezier'); assert.deepEqual(Array.from(e.c1),[11,14]);
  await h.click('undo'); assert.equal(h.state().doc.entities.length,1);
});

test('language switch translates static, live dimension, errors and AI task without altering geometry', async () => {
  const h=setup(); await h.tool('circle'); await h.tap(500,350); await h.tap(540,350);
  const before=JSON.stringify(h.state().doc.entities);
  assert.equal(h.el('language-toggle').textContent,'中文'); await h.click('language-toggle'); assert.equal(h.el('language-toggle').textContent,'English');
  assert.equal(h.el('copy-selected').textContent,'复制'); assert.match(h.el('coords').textContent,/毫米/);
  assert.equal(JSON.stringify(h.state().doc.entities),before); assert.match(h.log(),/已就绪/);
  await h.submit('chat-form','sk-testdummy12345'); await h.respond(0);
  const pending=h.submit('chat-form','画一个圆'); assert.equal(JSON.parse(h.requests[1].options.body).language,'zh');
  await h.respond(1,{reply:'已创建。',ops:[]}); await pending;
  assert.match(h.log(),/已创建。/);
  await h.click('language-toggle'); assert.equal(h.el('language-toggle').textContent,'中文'); assert.equal(h.el('copy-selected').textContent,'Copy');
});

test('saved-server mode requires explicit Connect before drawing without browser key', async () => {
  const h=setup(); await h.tick(); assert.equal(h.state().connState,'off'); assert.equal(h.el('connect-btn').hidden,false); assert.equal(h.healthCalls.length,0); await h.click('connect-btn'); await h.tick(); assert.equal(h.state().connState,'ready'); assert.equal(h.requests.length,0);
  const done=h.submit('chat-form','draw a circle');
  assert.equal(h.requests[0].options.headers['X-VectorForge-Auth'],'server');
  assert.equal(h.requests[0].options.headers.Authorization,undefined);
  await h.respond(0,{reply:'Created',ops:[{op:'circle',center:[0,0],radius:10}]}); await done;
  assert.equal(h.state().connState,'on'); assert.equal(h.state().doc.entities.length,1);
});

test('manual text tool validates, adds Unicode text, copies and undoes without outline claims', async () => {
  const h=setup();await h.tool('text');await h.tap(500,350);
  assert.equal(h.el('text-dialog').open,true); assert.equal(h.document.activeElement.id,'text-content');
  h.el('text-content').value='Chris 小陈';h.el('text-size').value='12'; await h.el('text-form').dispatch('submit');
  assert.equal(h.el('text-dialog').open,false); assert.equal(h.state().doc.entities[0].type,'text');
  assert.equal(h.state().doc.entities[0].text,'Chris 小陈');
  await h.click('copy-selected');await h.click('paste-selected'); assert.equal(h.state().doc.entities[1].size,12);
  assert.deepEqual(Array.from(h.state().doc.entities[1].c),[6,-6]); await h.click('undo');assert.equal(h.state().doc.entities.length,1);
  await h.tap(700,350);h.el('text-content').value='bad\ntext'; await h.el('text-form').dispatch('submit');
  assert.equal(h.el('text-error').hidden,false);assert.equal(h.state().doc.entities.length,1);await h.click('text-cancel');
});

test('default nearby labels form non-overlapping stack and retain a manually dragged offset', async () => {
  const h=setup(); await h.tool('line'); await h.tap(400,490); await h.tap(700,490);
  await h.tool('circle'); await h.tap(524,374); await h.tap(564,374);
  await h.tool('circle'); await h.tap(500,350); await h.tap(540,350); await h.tool('select');
  const boxes=h.state().dimBoxes.filter(b=>b.measurement); assert.equal(boxes.length,2);
  assert.ok(boxes[0].y+boxes[0].h <= boxes[1].y || boxes[1].y+boxes[1].h <= boxes[0].y);
  const b=boxes[0]; await h.pointer('pointerdown',b.x+8,b.y+8); await h.pointer('pointermove',b.x+88,b.y+8); await h.pointer('pointerup',b.x+88,b.y+8);
  const offset=JSON.stringify(h.state().labelOffsets[b.labelKey]);
  await h.click('measurements-toggle'); await h.click('measurements-toggle');
  assert.equal(JSON.stringify(h.state().labelOffsets[b.labelKey]),offset);
});

test('console Connect hides at server readiness, returns after error, and never spends on health check', async () => {
  const h=setup(); assert.doesNotMatch(h.html,/id="settings-btn"/); assert.equal(h.el('connect-btn').parent.id,'chat-form');
  await h.tick(); assert.equal(h.el('connect-btn').hidden,false); assert.equal(h.healthCalls.length,0); assert.equal(h.requests.length,0);
  await h.click('connect-btn'); await h.tick(); assert.equal(h.el('connect-btn').hidden,true);
  await h.click('conn-light'); await h.click('settings-disconnect'); assert.equal(h.el('connect-btn').hidden,false);
  await h.click('connect-btn'); await h.tick(); assert.equal(h.el('connect-btn').hidden,true); assert.equal(h.requests.length,0); assert.equal(h.state().connState,'ready');
  const done=h.submit('chat-form','circle'); await h.respond(0,{},401); await done;
  assert.equal(h.el('connect-btn').hidden,false); assert.equal(h.state().connState,'error');
  await h.click('connect-btn'); await h.tick(); assert.equal(h.requests.length,1); assert.equal(h.el('connect-btn').hidden,true);
});

test('explicit console handshake is singleflight and reports success without provider request', async () => {
  const h=setup({deferredHealth:true}); await h.tick(); assert.equal(h.healthCalls.length,0);
  await h.click('connect-btn'); assert.equal(h.state().connState,'checking'); assert.equal(h.el('connect-btn').hidden,false); assert.equal(h.el('connect-btn').disabled,true);
  await h.click('connect-btn'); await h.click('conn-light'); h.el('set-relay-url').value='http://localhost:4226/api/cad-chat'; await h.el('settings-form').dispatch('submit');
  assert.equal(h.healthCalls.length,1); assert.notEqual(h.state().connection.relay,'http://localhost:4226/api/cad-chat');
  await h.click('settings-close'); h.healthCalls[0].resolve(h.healthResult()); await h.tick();
  assert.equal(h.state().connState,'ready'); assert.equal(h.el('connect-btn').hidden,true); assert.match(h.log(),/Connected to drawing service/); assert.equal(h.requests.length,0);
  assert.equal((h.log().match(/Checking the connection/g)||[]).length,1); assert.equal((h.log().match(/Connected to drawing service/g)||[]).length,1);
});

test('settings handshake closes dialog and displays Chinese readiness rather than silent checking', async () => {
  const h=setup({deferredHealth:true}); await h.click('language-toggle'); await h.click('conn-light'); await h.el('settings-form').dispatch('submit');
  assert.equal(h.el('settings-dialog').open,false); assert.equal(h.healthCalls.length,1); assert.equal(h.state().connState,'checking');
  h.healthCalls[0].resolve(h.healthResult()); await h.tick(); assert.match(h.log(),/已连接绘图服务/); assert.equal(h.requests.length,0);
});

test('stopped health cannot hide Connect and health failure can retry cleanly', async () => {
  const h=setup({deferredHealth:true}); await h.click('connect-btn'); await h.click('cancel-request');
  h.healthCalls[0].resolve(h.healthResult()); await h.tick(); assert.equal(h.state().connState,'off'); assert.equal(h.el('connect-btn').hidden,false); assert.doesNotMatch(h.log(),/Connected to drawing service/);
  await h.click('connect-btn'); h.healthCalls[1].resolve(h.healthResult(200,false)); await h.tick();
  assert.equal(h.state().connState,'error'); assert.equal(h.el('connect-btn').hidden,false); assert.equal(h.el('connect-btn').disabled,false); assert.match(h.log(),/not configured/);
  await h.click('connect-btn'); h.healthCalls[2].resolve(h.healthResult()); await h.tick(); assert.equal(h.state().connState,'ready'); assert.equal(h.requests.length,0);
});

test('health timeout restores enabled Connect and reports timeout', async () => {
  const h=setup({deferredHealth:true,quickTimeout:true}); await h.click('connect-btn'); await new Promise(r=>setTimeout(r,10)); await h.tick();
  assert.equal(h.state().connState,'error'); assert.equal(h.el('connect-btn').hidden,false); assert.equal(h.el('connect-btn').disabled,false); assert.equal(h.el('send-btn').disabled,false); assert.match(h.log(),/timed out/); assert.equal(h.requests.length,0);
});

// Exercise AI-created polygons through the real body-drag event path. The
// provider is the harness's local mock; these tests make no network requests.
async function translationScene(ops) {
  const h=setup(); await h.connect();
  const done=h.submit('chat-form','Create translation snap fixtures');
  await h.respond(1,{reply:'Fixtures ready',ops}); await done;
  await h.click('measurements-toggle');
  // Deselect first so the grab is deliberately not a resize/rotation grip.
  await h.tap(100,600);
  return h;
}
const triangleOp={op:'polygon',center:[0,0],radius:10,sides:3,rotation:0};
const approxPoint=(actual,expected,epsilon=1e-6)=>actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<epsilon,`${actual} ≈ ${expected}`));

test('triangle body snaps its vertex to a line, preserves grab offset and shape, and releases without drift', async()=>{
  const h=await translationScene([{op:'line',from:[30,-30],to:[30,70]},triangleOp]);
  const [line,triangle]=h.state().doc.entities, before=JSON.stringify(h.state().doc.entities), count=h.state().undoStack.length;
  const originalPoints=model.entityPoints(triangle);
  await h.pointer('pointerdown',504,350); // Grab 1 mm right of center, not the snapping vertex.
  await h.pointer('pointermove',578,350); // Raw translation is 18.5 mm.
  approxPoint(triangle.c,[20,0]); approxPoint(model.entityPoints(triangle)[0],[30,0]);
  assert.equal(h.state().snapTarget.entityId,line.id); assert.equal(h.state().snapTarget.kind,'nearest');
  approxPoint(h.state().snapTarget.point,[30,0]);
  assert.deepEqual([triangle.R,triangle.n,triangle.rot],[10,3,0]);
  model.entityPoints(triangle).forEach((p,i)=>approxPoint(p,originalPoints[i].map((v,j)=>v+(j===0?20:0))));
  await h.pointer('pointermove',579,350); approxPoint(triangle.c,[20,0]);
  await h.click('snap-toggle'); await h.pointer('pointermove',578,350);
  approxPoint(triangle.c,[18.5,0]); assert.equal(h.state().snapTarget,null);
  await h.click('snap-toggle'); await h.pointer('pointermove',578,350); approxPoint(triangle.c,[20,0]);
  await h.pointer('pointermove',744,350); approxPoint(triangle.c,[60,0]); assert.equal(h.state().snapTarget,null);
  await h.pointer('pointerup',744,350); assert.equal(h.state().undoStack.length,count+1);
  await h.click('undo'); assert.equal(JSON.stringify(h.state().doc.entities),before);
  await h.click('redo'); approxPoint(h.state().doc.entities[1].c,[60,0]);
});

test('triangle body vertex snaps to a circle outline without resizing or rotating',async()=>{
  const h=await translationScene([{op:'circle',center:[40,0],radius:10},triangleOp]);
  const [circle,triangle]=h.state().doc.entities;
  await h.pointer('pointerdown',504,350); await h.pointer('pointermove',578,350);
  approxPoint(triangle.c,[20,0]); approxPoint(model.entityPoints(triangle)[0],[30,0]);
  assert.equal(h.state().snapTarget.entityId,circle.id); assert.equal(h.state().snapTarget.kind,'nearest');
  assert.deepEqual([triangle.R,triangle.n,triangle.rot],[10,3,0]);
  await h.pointer('pointercancel',578,350);
  await h.pointer('pointermove',650,350); approxPoint(triangle.c,[20,0]);
});

test('triangle body snaps a vertex to a true cubic outline away from endpoints and midpoint',async()=>{
  const h=await translationScene([{op:'bezier',from:[30,-40],control1:[50,-20],control2:[50,20],to:[30,40]},triangleOp]);
  const [curve,triangle]=h.state().doc.entities;
  const rawVertex=[41.6,-17.68], expected=spatial.nearestPointOnEntity(rawVertex,curve,{scale:4});
  await h.pointer('pointerdown',504,350); await h.pointer('pointermove',630.4,420.72);
  approxPoint(model.entityPoints(triangle)[0],expected,1e-5);
  assert.equal(h.state().snapTarget.entityId,curve.id); assert.equal(h.state().snapTarget.kind,'nearest');
  assert.deepEqual([triangle.R,triangle.n,triangle.rot],[10,3,0]);
  await h.pointer('pointerup',630.4,420.72);
});

test('body snapping excludes the moving shape and stays off when disabled',async()=>{
  const h=await translationScene([triangleOp]); const triangle=h.state().doc.entities[0];
  await h.pointer('pointerdown',504,350); await h.pointer('pointermove',509,350);
  approxPoint(triangle.c,[1.25,0]); assert.equal(h.state().snapTarget,null);
  await h.pointer('pointerup',509,350);
  const off=await translationScene([{op:'line',from:[30,-30],to:[30,70]},triangleOp]);
  await off.click('snap-toggle'); await off.pointer('pointerdown',504,350); await off.pointer('pointermove',578,350);
  approxPoint(off.state().doc.entities[1].c,[18.5,0]); assert.equal(off.state().snapTarget,null);
});

test('triangle edge midpoint and center are translation anchors at screen-scaled tolerance',async()=>{
  const h=await translationScene([{op:'line',from:[-25,0],to:[-25,5]},triangleOp]);
  const [line,triangle]=h.state().doc.entities;
  await h.pointer('pointerdown',504,350); await h.pointer('pointermove',430,350);
  approxPoint(triangle.c,[-20,0]); approxPoint(h.state().snapTarget.point,[-25,0]);
  assert.equal(h.state().snapTarget.entityId,line.id); assert.equal(h.state().snapTarget.kind,'endpoint');
  const points=model.entityPoints(triangle);
  approxPoint(points[1].map((v,i)=>(v+points[2][i])/2),[-25,0]);
  await h.pointer('pointerup',430,350);

  const center=await translationScene([{op:'line',from:[30,0],to:[30,1]},{...triangleOp,radius:20}]);
  // Eight pixels per world unit: 1.5 mm is now outside the ten-pixel tolerance.
  center.state().view.s=8;
  await center.pointer('pointerdown',504,350); await center.pointer('pointermove',732,350);
  approxPoint(center.state().doc.entities[1].c,[28.5,0]); assert.equal(center.state().snapTarget,null);
  await center.pointer('pointermove',738,350);
  approxPoint(center.state().doc.entities[1].c,[30,0]); approxPoint(center.state().snapTarget.point,[30,0]);
});

test('moving cubic control handles are never mistaken for body outline anchors',async()=>{
  const h=await translationScene([{op:'line',from:[-5,55],to:[5,55]},
    {op:'bezier',from:[-20,0],control1:[0,40],control2:[20,40],to:[40,0]}]);
  const curve=h.state().doc.entities[1], before=JSON.parse(JSON.stringify(curve));
  await h.pointer('pointerdown',540,230); await h.pointer('pointermove',540,174);
  assert.equal(h.state().snapTarget,null);
  for(const key of ['p1','c1','c2','p2']) approxPoint(curve[key],[before[key][0],before[key][1]+14]);
});

test('workshop opens separate import/template flows, previews before applying, and cancels safely', async()=>{
  const h=setup();await h.click('workshop-open');assert.equal(h.el('workshop-dialog').open,true);assert.equal(h.el('workshop-import').hidden,false);await h.click('workshop-close');assert.equal(h.el('workshop-dialog').open,false);
  await h.click('templates-open');assert.equal(h.el('workshop-templates').hidden,false);h.el('template-select').value='keytag';await h.el('template-select').dispatch('change');await h.click('template-preview');assert.equal(h.el('template-result').hidden,false);assert.equal(h.state().doc.entities.length,0);await h.click('template-accept');assert.ok(h.state().doc.entities.some(e=>e.type==='path'&&e.hole));assert.equal(h.el('workshop-dialog').open,false);await h.click('undo');assert.equal(h.state().doc.entities.length,0);
});
test('fabrication export requires review and reports unclosed lines before export',async()=>{const h=setup();await h.tool('line');await h.tap(400,300);await h.tap(500,300);await h.click('export-svg');assert.equal(h.el('workshop-checks').hidden,false);assert.equal(h.el('export-reviewed').checked,false);await h.click('checked-svg');assert.equal(h.el('workshop-error').hidden,false);assert.match(h.el('checks-list').textContent,/open|closed|check.open_cut_path/i);});
test('image annotation chooses two points, preserves vector geometry, and is undoable',async()=>{const h=setup();h.state().doc.references=[{id:'image-1',name:'Paper',dataURL:'data:image/png;base64,AA==',center:[0,0],width:100,height:100,rotation:0,opacity:.5,locked:true,calibrated:false}];await h.click('workshop-open');await h.click('reference-measure');await h.tap(400,300);await h.tap(600,300);assert.equal(h.el('annotation-dialog').open,true);h.el('annotation-value').value='80';h.el('annotation-text').value='known';await h.el('annotation-form').dispatch('submit');assert.equal(h.state().doc.annotations.length,1);assert.equal(h.state().doc.annotations[0].value,80);assert.equal(h.state().doc.references[0].width,100);assert.equal(h.state().doc.entities.length,0);await h.click('undo');assert.equal(h.state().doc.annotations.length,0);});
test('calibration rescales only the chosen reference and saves an explicit annotation',async()=>{const h=setup();h.state().doc.references=[{id:'image-1',name:'Paper',dataURL:'data:image/png;base64,AA==',center:[0,0],width:100,height:100,rotation:0,opacity:.5,locked:true,calibrated:false}];await h.click('workshop-open');await h.click('reference-calibrate');await h.tap(400,300);await h.tap(600,300);h.el('annotation-value').value='100';await h.el('annotation-form').dispatch('submit');assert.equal(h.state().doc.references[0].width,200);assert.equal(h.state().doc.references[0].calibrated,true);assert.equal(h.state().doc.annotations[0].value,100);});
test('reference geometry is omitted from AI scenes and complex scene is stopped before network',async()=>{const h=setup();await h.connect();model.applyOps(h.state().doc,[{op:'text',text:'private note',layer:'reference'}]);h.submit('chat-form','draw a circle');await h.tick();const body=JSON.parse(h.requests.at(-1).options.body);assert.doesNotMatch(JSON.stringify(body),/private note/);await h.respond(h.requests.length-1);model.applyOps(h.state().doc,[{op:'path',points:Array.from({length:2000},(_,i)=>[i,i%3]),closed:false}]);const count=h.requests.length;await h.submit('chat-form','draw a square');assert.equal(h.requests.length,count);assert.match(h.log(),/too complex/i);});
