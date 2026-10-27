import { createHostAdapter } from './src/host-adapter.js';

export const name = 'delete-conversation';
export const inject = ['connection', 'loader', 'agentLoop', 'agents', 'sessions', 'sessionPersistence', 'workspaceRegistry', 'storageDomain', 'sessionProjectionCache', 'sessionQuery'];

/** The custom channel inherits DSH's browser authentication and Host/Origin checks. */
export function createRpcHandler(adapter) {
  return async (endpoint, payload, signal, peer) => {
    const failure = (code, message) => ({ ok: false, error: { code, message, details: {} } });
    if (peer?.principal?.kind !== 'owner') return failure('delete/forbidden', 'Only the DSH owner can delete conversations.');
    if (endpoint !== 'delete') return failure('delete/not-found', 'Unknown deletion operation.');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).some((key) => !['sessionId', 'confirm'].includes(key))
      || typeof payload.sessionId !== 'string' || payload.confirm !== true) {
      return failure('delete/bad-request', 'A sessionId and explicit confirmation are required.');
    }
    try {
      signal?.throwIfAborted();
      const value = await adapter.deleteSession(payload.sessionId);
      return { ok: true, value };
    } catch (error) {
      return failure(typeof error?.code === 'string' ? error.code : 'delete/failed', error instanceof Error ? error.message : String(error));
    }
  };
}

export function createFetchHandler(adapter) {
  const rpc = createRpcHandler(adapter);
  return async (request) => {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return new Response('Expected application/json', { status: 415 });
    }
    let envelope;
    try { envelope = await request.json(); }
    catch { return new Response('Invalid JSON', { status: 400 }); }
    if (envelope?.type !== 'client-request' || typeof envelope.rpcId !== 'string'
      || envelope.method !== 'dsh-delete-conversation/delete') {
      return new Response('Invalid deletion request envelope', { status: 400 });
    }
    // DSH Connection admits authenticated peers and rejects non-owner peers BEFORE
    // dispatching an exact Fetch route (dsh-client-connection 0.2.1-rc.3).
    const result = await rpc('delete', envelope.payload, request.signal, { principal: { kind: 'owner' } });
    return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result });
  };
}

export async function apply(ctx) {
  const adapter = await createHostAdapter(ctx);
  ctx.effect(() => () => adapter.dispose(), 'delete-conversation: adapter');
  ctx.connection.fetch.register({
    path: '/api/dsh-delete-conversation/delete',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: createFetchHandler(adapter),
  });
}
