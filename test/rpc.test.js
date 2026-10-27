import test from 'node:test';
import assert from 'node:assert/strict';
import { createRpcHandler, createFetchHandler } from '../index.js';

const owner = { principal: { kind: 'owner' } };
const request = { sessionId: 'session-test', confirm: true };

test('only an authenticated owner can reach permanent deletion', async () => {
  let calls = 0;
  const rpc = createRpcHandler({ deleteSession: async () => { calls++; } });
  for (const peer of [undefined, {}, { principal: { kind: 'guest' } }]) {
    assert.equal((await rpc('delete', request, undefined, peer)).error.code, 'delete/forbidden');
  }
  assert.equal(calls, 0);
});

test('confirmation and exact input shape are required', async () => {
  let calls = 0;
  const rpc = createRpcHandler({ deleteSession: async () => { calls++; } });
  for (const payload of [null, [], {}, { sessionId: 'session-test' }, { ...request, confirm: false }, { ...request, path: '/' }]) {
    assert.equal((await rpc('delete', payload, undefined, owner)).error.code, 'delete/bad-request');
  }
  assert.equal((await rpc('erase-all', request, undefined, owner)).error.code, 'delete/not-found');
  assert.equal(calls, 0);
});

test('aborted requests cannot begin deletion', async () => {
  let calls = 0;
  const rpc = createRpcHandler({ deleteSession: async () => { calls++; } });
  const controller = new AbortController();
  controller.abort(new Error('Connection closed'));
  assert.equal((await rpc('delete', request, controller.signal, owner)).ok, false);
  assert.equal(calls, 0);
});

test('returns success only after cleanup, and preserves failure messages', async () => {
  const result = { sessionId: request.sessionId, deleted: true };
  const success = createRpcHandler({ deleteSession: async (id) => { assert.equal(id, request.sessionId); return result; } });
  assert.deepEqual(await success('delete', request, undefined, owner), { ok: true, value: result });
  const failure = createRpcHandler({ deleteSession: async () => { throw new Error('Session is locked by another process'); } });
  const response = await failure('delete', request, undefined, owner);
  assert.equal(response.ok, false);
  assert.match(response.error.message, /locked by another process/);
});

test('exact API route validates transport envelopes before deletion', async () => {
  let calls = 0;
  const fetchHandler = createFetchHandler({ deleteSession: async () => { calls++; return { deleted: true }; } });
  const make = (body, contentType = 'application/json') => new Request('http://localhost/api/dsh-delete-conversation/delete', {
    method: 'POST', headers: { 'content-type': contentType }, body,
  });
  assert.equal((await fetchHandler(make('{}', 'text/plain'))).status, 415);
  assert.equal((await fetchHandler(make('{broken'))).status, 400);
  assert.equal((await fetchHandler(make(JSON.stringify({ type: 'client-request', rpcId: '1', method: 'wrong', payload: request })))).status, 400);
  assert.equal(calls, 0);
  const response = await fetchHandler(make(JSON.stringify({ type: 'client-request', rpcId: 'test-correlation', method: 'dsh-delete-conversation/delete', payload: request })));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { type: 'server-response', rpcId: 'test-correlation', result: { ok: true, value: { deleted: true } } });
  assert.equal(calls, 1);
});
