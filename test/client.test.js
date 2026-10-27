import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { createClientPlugin } from '../src/client.js';

const dictionaries = Object.fromEntries(await Promise.all(['en', 'zh'].map(async (lang) => [lang,
  JSON.parse(await readFile(new URL(`../locale/${lang}.json`, import.meta.url), 'utf8')),
])));

test('delete UI requires confirmation, prevents repeat requests, and reports failure without hiding the conversation', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const registrations = new Map();
  const cleanups = [];
  const calls = [];
  let complete;
  let reconnects = 0;
  const ctx = {
    locale: { register: () => () => {} },
    effect: (factory) => { const cleanup = factory(); cleanups.push(cleanup); return cleanup; },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => { registrations.set(options.name, { component, options }); return () => {}; },
    },
    connection: {
      rpc: { call: (...args) => { calls.push(args); return new Promise((resolve) => { complete = resolve; }); } },
      reconnect: () => { reconnects++; },
    },
  };
  createClientPlugin(React, dictionaries).apply(ctx);
  const Row = registrations.get('sidebar.workspaces.session.row.action').component;
  const Overlay = registrations.get('shell.overlay').component;
  const t = (key) => dictionaries.zh[key];
  const root = createRoot(document.getElementById('root'));
  const click = async (selector) => act(async () => { document.querySelector(selector).click(); });
  try {
    await act(async () => root.render(React.createElement(React.Fragment, null,
      React.createElement(Row, { sessionId: 'fixture-id', displayTitle: 'Only this conversation', t }),
      React.createElement(Overlay, { t }))));
    await click('.dsh-delete-button');
    assert.equal(calls.length, 0, 'opening confirmation must never invoke deletion');
    assert.equal(document.querySelector('dialog').open, true);
    assert.equal(document.querySelector('.dsh-delete-title').textContent, 'Only this conversation');
    assert.equal(document.activeElement.textContent, dictionaries.zh.cancel);
    await click('.dsh-delete-footer button');
    assert.equal(document.querySelector('dialog'), null);
    assert.equal(calls.length, 0);

    await click('.dsh-delete-button');
    await click('.dsh-delete-confirm');
    await click('.dsh-delete-confirm');
    assert.equal(calls.length, 1, 'double click must issue only one destructive request');
    assert.deepEqual(calls[0], ['/api', 'dsh-delete-conversation/delete', { sessionId: 'fixture-id', confirm: true }]);
    assert.equal(document.querySelector('.dsh-delete-confirm').disabled, true);
    await act(async () => document.querySelector('dialog').dispatchEvent(new dom.window.Event('cancel', { cancelable: true })));
    assert.equal(document.querySelector('dialog').open, true, 'Escape cannot dismiss an in-flight operation');
    await act(async () => complete({ ok: false, error: { message: 'Another process holds the write lock' } }));
    assert.match(document.querySelector('[role="alert"]').textContent, /write lock/);
    assert.equal(document.querySelector('.dsh-delete-confirm').disabled, false);
    assert.equal(reconnects, 0);

    await click('.dsh-delete-confirm');
    assert.equal(calls.length, 2);
    await act(async () => complete({ ok: true, value: { deleted: true } }));
    assert.equal(document.querySelector('dialog'), null);
    assert.equal(reconnects, 1, 'refresh the authoritative catalog only after success');
    await click('.dsh-delete-button');
    await click('.dsh-delete-confirm');
    await act(async () => complete({ ok: true, value: { deleted: true, warnings: [{ message: 'Historical shared cache retained' }] } }));
    assert.match(document.querySelector('[role="status"]').textContent, /cache retained/);
    assert.equal(document.querySelector('.dsh-delete-confirm'), null);
    assert.equal(document.querySelector('h2').textContent, dictionaries.zh.completedTitle);
    await click('.dsh-delete-footer button');
    assert.equal(document.querySelector('dialog'), null);
  } finally {
    await act(async () => root.unmount());
    for (const cleanup of cleanups.reverse()) cleanup?.();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
