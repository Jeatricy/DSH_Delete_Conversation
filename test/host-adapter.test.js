import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join, dirname, basename } from 'node:path';
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHostAdapter, findLifecycleDisposer, checkedSessionDirectory, removeProjectionCacheCopies } from '../src/host-adapter.js';

const EFFECT = Symbol.for('cordis.effect');
function fixture({ live = true, badDisposer = false, lockBusy = false } = {}) {
  const id = 'session-test';
  const root = resolve('virtual-dsh-data', 'sessions');
  const dir = join(root, '--project--', id);
  const cacheRoot = resolve('virtual-dsh-data', 'storages');
  const header = { id, cwd: resolve('virtual-workspace'), version: 4, createdAt: 1, isSeeded: false };
  const events = [];
  let onDisk = true;
  let lease = false;
  const session = { id, header };
  let currentSession = live ? session : undefined;
  let currentAgent;
  const agentFiber = {};
  const scope = { ctx: { fiber: agentFiber }, dispose() { assert.fail('Inner scope disposer must never be used directly'); } };
  const writers = new Map();
  const disposer = async () => {
    events.push('lifecycle');
    events.push('cancel', 'idle', 'scope-cleanup', 'writer-close');
    writers.delete(id);
    currentAgent = undefined;
    currentSession = undefined;
    events.push('detach');
  };
  disposer[EFFECT] = { label: `agentLoop.${badDisposer ? 'wrong' : 'scope'}(${id})`, children: [{ label: 'ctx.plugin()' }] };
  const ownerDisposer = async () => { events.push('owner-release'); };
  ownerDisposer[EFFECT] = { label: `agentLoop.lifecycle(${id})`, children: [] };
  const agent = { id, session, scope, ctx: scope.ctx,
    loopCtx: { fiber: { _disposables: [disposer] }, registry: { values: () => [{ fibers: [{ _disposables: [ownerDisposer] }] }] } }, send() {} };
  currentAgent = live ? agent : undefined;
  if (live) writers.set(id, { live: true });
  const fs = {
    async lstat(path) {
      if (path === cacheRoot || (path === dir && !onDisk)) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      return { isDirectory: () => true, isSymbolicLink: () => false };
    },
    async realpath(path) { return path; },
    async readdir() { return []; },
    async rm(path) { assert.equal(path, dir); assert.equal(lease, true); events.push('rm'); onDisk = false; }
  };
  const persistence = {
    root, tracker: { writers }, coldLogMemo: new Map([[id, 'old log']]),
    async stat(requested) { return requested === id && onDisk ? { header } : undefined; },
    async list() { return [...(onDisk ? [{ header }] : []), { header: { ...header, id: 'session-fork', parentSession: id } }]; },
    locate() { return { kind: 'jsonl', path: join(dir, 'session.v4.jsonl.zst') }; },
    async open(requested, access) {
      assert.equal(requested, id); assert.equal(access, 'write');
      if (lockBusy) throw Object.assign(new Error('owned by another process'), { name: 'SessionAlreadyOwnedError' });
      assert.equal(writers.has(id), false);
      events.push('lock'); lease = true;
      return { async close() { if (lease) events.push('lock-close'); lease = false; } };
    },
    async create() {},
    memoizeStoredLog(key, value) { this.coldLogMemo.set(key, value); }
  };
  const cacheRecords = new Map([[id, 'checkpoint']]);
  const cacheTable = { async delete(key) { events.push('cache-delete'); cacheRecords.delete(key); } };
  const workspace = {
    headers: new Map([[id, header]]), sessionPaths: new Map([[id, header.cwd]]),
    missingSessionPaths: new Set(), invalidSessionPaths: new Map(),
    async archiveSession() { events.push('archive'); },
    async unarchiveSession() { events.push('unarchive'); },
    async unpinSession() { events.push('unpin'); },
    list() { return [{ async detachSession(key) { assert.equal(key, id); events.push('workspace-detach'); } }]; }
  };
  const scheduleTasks = [{ id: 'active', sessionId: id, status: 'active' }, { id: 'inactive', sessionId: id, status: 'inactive' }, { id: 'foreign', sessionId: 'session-foreign' }];
  const schedule = {
    async serialize(job) { return job(); },
    async catalog() { return scheduleTasks.slice(); },
    async delete({ id: taskId }) { events.push(`schedule-${taskId}`); scheduleTasks.splice(scheduleTasks.findIndex(task => task.id === taskId), 1); },
    async create() {}, async update() {}
  };
  const observations = { cache: new Map([[id, 'observation']]), store(key, value) { this.cache.set(key, value); } };
  const query = {
    config: { path: ':memory:' }, _ready: Promise.resolve(), _observations: observations,
    async observeSession() { return { [Symbol.dispose]() {} }; },
    async _serialized(_signal, job) { return job(); },
    async _ensureReady() {},
    async _reconcile() { assert.equal(onDisk, false); events.push('query-reconcile'); }
  };
  const ctx = {
    agents: { get: key => key === id ? currentAgent : undefined, list: () => currentAgent ? [currentAgent] : [], enter() {} },
    sessions: { get: key => key === id ? currentSession : undefined, enter() {} },
    sessionPersistence: persistence, workspaceRegistry: workspace,
    sessionProjectionCache: { async put(key, _identity, value) { cacheRecords.set(key, value); } },
    sessionQuery: query, storageDomain: { get: () => ({ table: () => cacheTable, enqueue: job => job(),
      unit: { dir: join(cacheRoot, 'session_projcache'), descriptor: { name: 'session_projcache', layout: 'per-record', tables: ['sessions'], version: 7, compatibleVersions: [3, 4, 5, 6] } } }) },
    schedule, subagents: { async drainDescendants(parents) { assert.deepEqual(parents, [agent]); events.push('children-drain'); } },
    sessionController: { agents: { async resolve() { return { agent }; } } },
    get(key) { return this[key]; },
    on() { return () => {}; },
    emit(name, key) { assert.equal(name, 'api-session/removed'); assert.equal(key, id); events.push('removed'); }
  };
  return { id, root, dir, header, ctx, agent, disposer, fs, events, cacheRecords, scheduleTasks,
    options: { fs, verifyVersion: async () => {} }, onDisk: () => onDisk };
}

test('live deletion uses exact outer lifecycle and holds deletion lease through cleanup', async () => {
  const f = fixture();
  const adapter = await createHostAdapter(f.ctx, f.options);
  const result = await adapter.deleteSession(f.id);
  assert.deepEqual(f.events, ['archive', 'children-drain', 'lifecycle', 'cancel', 'idle', 'scope-cleanup', 'writer-close', 'detach', 'owner-release',
    'lock', 'rm', 'schedule-active', 'schedule-inactive', 'workspace-detach', 'unpin', 'unarchive', 'cache-delete', 'query-reconcile', 'lock-close', 'removed']);
  assert.equal(result.preservedDescendants, 1);
  assert.equal(result.sharedAttachmentsRetained, true);
  assert.equal(f.ctx.workspaceRegistry.headers.has(f.id), false);
  assert.equal(f.cacheRecords.has(f.id), false);
  assert.equal(f.ctx.sessionQuery._observations.cache.has(f.id), false);
  assert.deepEqual(f.scheduleTasks.map(task => task.id), ['foreign']);
  assert.equal(await f.ctx.sessionPersistence.stat(f.id), undefined);
  assert.throws(() => f.ctx.sessionPersistence.open(f.id, 'write'), { code: 'session-deleting' });
  assert.throws(() => f.ctx.sessions.enter({ id: f.id }), { code: 'session-deleting' });
  await f.ctx.sessionProjectionCache.put(f.id, {}, 'late checkpoint');
  assert.equal(f.cacheRecords.has(f.id), false);
  await adapter.dispose();
});

test('wrong or duplicate lifecycle disposer fails closed before side effects', async () => {
  const f = fixture({ badDisposer: true });
  const adapter = await createHostAdapter(f.ctx, f.options);
  await assert.rejects(adapter.deleteSession(f.id), { code: 'unsupported-host' });
  assert.deepEqual(f.events, []);
  assert.equal(f.onDisk(), true);
  f.disposer[EFFECT].label = `agentLoop.scope(${f.id})`;
  f.agent.loopCtx.fiber._disposables.push(f.disposer);
  assert.throws(() => findLifecycleDisposer(f.agent, f.ctx.agents, f.ctx.sessions), { code: 'unsupported-host' });
  await adapter.dispose();
});

test('cold deletion acquires cross-process ownership and never fabricates lifecycle', async () => {
  const f = fixture({ live: false });
  const adapter = await createHostAdapter(f.ctx, f.options);
  await adapter.deleteSession(f.id);
  assert.equal(f.events.includes('archive'), false);
  assert.equal(f.events.includes('lifecycle'), false);
  assert.equal(f.events[0], 'lock');
  await adapter.dispose();
});

test('foreign writer lock refusal never removes artifacts or metadata', async () => {
  const f = fixture({ live: false, lockBusy: true });
  const adapter = await createHostAdapter(f.ctx, f.options);
  await assert.rejects(adapter.deleteSession(f.id), { name: 'SessionAlreadyOwnedError' });
  assert.deepEqual(f.events, []);
  assert.equal(f.onDisk(), true);
  assert.equal(adapter.isDeleted(f.id), false);
  await adapter.dispose();
});

test('path traversal and symlink directories are refused', async () => {
  const f = fixture({ live: false });
  f.ctx.sessionPersistence.locate = () => ({ kind: 'jsonl', path: join(f.root, '..', f.id, 'session.jsonl') });
  await assert.rejects(checkedSessionDirectory(f.ctx.sessionPersistence, f.header, f.fs), { code: 'unsupported-host' });
  f.ctx.sessionPersistence.locate = () => ({ kind: 'jsonl', path: join(f.dir, 'session.jsonl') });
  f.fs.lstat = async () => ({ isDirectory: () => true, isSymbolicLink: () => true });
  await assert.rejects(checkedSessionDirectory(f.ctx.sessionPersistence, f.header, f.fs), { code: 'unsupported-host' });
});

test('duplicate delete calls serialize, and a completed delete is idempotent', async () => {
  const f = fixture({ live: false });
  const adapter = await createHostAdapter(f.ctx, f.options);
  const first = adapter.deleteSession(f.id);
  assert.equal(adapter.deleteSession(f.id), first);
  const result = await first;
  assert.equal(await adapter.deleteSession(f.id), result);
  assert.equal(f.events.filter(item => item === 'rm').length, 1);
  await adapter.dispose();
});

test('cleanup failure keeps admission blocked and supports retry after log removal', async () => {
  const f = fixture({ live: false });
  let failOnce = true;
  const originalDelete = f.ctx.schedule.delete;
  f.ctx.schedule.delete = async function(request) {
    if (failOnce) { failOnce = false; throw new Error('simulated schedule storage failure'); }
    return originalDelete.call(this, request);
  };
  const adapter = await createHostAdapter(f.ctx, f.options);
  await assert.rejects(adapter.deleteSession(f.id), { code: 'cleanup-incomplete' });
  assert.equal(f.onDisk(), false);
  assert.equal(adapter.isDeleted(f.id), true);
  assert.equal((await adapter.deleteSession(f.id)).deleted, true);
  assert.equal(f.events.filter(item => item === 'rm').length, 1);
  await adapter.dispose();
});

test('unknown package version/context is refused before patching services', async () => {
  const f = fixture();
  const originalOpen = f.ctx.sessionPersistence.open;
  await assert.rejects(createHostAdapter(f.ctx), { code: 'unsupported-host' });
  assert.equal(f.ctx.sessionPersistence.open, originalOpen);
});

test('plugin disposal restores wrapped methods', async () => {
  const f = fixture();
  const original = f.ctx.sessionPersistence.open;
  const adapter = await createHostAdapter(f.ctx, f.options);
  assert.notEqual(f.ctx.sessionPersistence.open, original);
  await adapter.dispose();
  assert.equal(f.ctx.sessionPersistence.open, original);
  await assert.rejects(adapter.deleteSession(f.id), { code: 'adapter-stopping' });
});

async function cacheFixture(t) {
  const temporaryRoot = resolve(tmpdir());
  const root = await nodeFs.mkdtemp(join(temporaryRoot, 'dsh-delete-cache-test-'));
  const dir = join(root, 'session_projcache');
  const table = join(dir, 'sessions');
  const legacy = join(root, 'session_projcache.json');
  await nodeFs.mkdir(table, { recursive: true });
  t.after(async () => {
    assert.equal(dirname(root), temporaryRoot);
    assert.match(basename(root), /^dsh-delete-cache-test-[A-Za-z0-9]+$/);
    await nodeFs.rm(root, { recursive: true, force: true });
  });
  let chain = Promise.resolve();
  const domain = { unit: { dir, descriptor: { name: 'session_projcache', layout: 'per-record',
    tables: ['sessions'], version: 7, compatibleVersions: [3, 4, 5, 6] } },
    enqueue(job) { const task = chain.then(job); chain = task.catch(() => {}); return task; } };
  return { root, dir, table, legacy, domain };
}

test('only exact timestamped backups for the selected id are removed', async t => {
  const f = await cacheFixture(t);
  const removed = ['session-a.json.bak.202610271200', 'session-a.json.bak.202610271201'];
  const retained = ['session-a-other.json.bak.202610271200', 'session-b.json.bak.202610271200',
    'session-a.json.bak.unknown', 'session-a.json.bak.202610271200.extra', 'session-a.json'];
  for (const name of [...removed, ...retained]) await nodeFs.writeFile(join(f.table, name), name);
  const result = await removeProjectionCacheCopies(f.domain, 'session-a');
  assert.equal(result.backupFilesRemoved, 2);
  assert.deepEqual((await nodeFs.readdir(f.table)).sort(), retained.sort());
  assert.deepEqual(result.warnings, []);
});

test('legacy cache cleanup preserves all unrelated records and metadata', async t => {
  const f = await cacheFixture(t);
  const expected = { unit: { name: 'session_projcache', version: 3, extra: 'kept' },
    global: { historical: true }, tables: { sessions: { 'session-b': { rows: 'B' } },
      other: { preserved: [1, 2, 3] } }, extra: { keep: true } };
  const original = structuredClone(expected);
  original.tables.sessions['session-a'] = { rows: 'private A' };
  await nodeFs.writeFile(f.legacy, JSON.stringify(original));
  const result = await removeProjectionCacheCopies(f.domain, 'session-a');
  assert.equal(result.legacyRecordRemoved, true);
  assert.deepEqual(JSON.parse(await nodeFs.readFile(f.legacy, 'utf8')), expected);
  assert.deepEqual((await nodeFs.readdir(f.root)).sort(), ['session_projcache', 'session_projcache.json']);
});

test('shared domain queue preserves concurrent deletion of different legacy records', async t => {
  const f = await cacheFixture(t);
  await nodeFs.writeFile(f.legacy, JSON.stringify({ unit: { name: 'session_projcache', version: 6 },
    global: null, tables: { sessions: { 'session-a': 1, 'session-b': 2, 'session-c': 3 } } }));
  await Promise.all(['session-a', 'session-b'].map(id => f.domain.enqueue(() => removeProjectionCacheCopies(f.domain, id))));
  assert.deepEqual(JSON.parse(await nodeFs.readFile(f.legacy, 'utf8')).tables.sessions, { 'session-c': 3 });
});

test('unknown or malformed shared legacy cache is retained with explicit warning', async t => {
  const f = await cacheFixture(t);
  for (const content of ['{broken', JSON.stringify({ unit: { name: 'other', version: 7 }, tables: {} }),
    JSON.stringify({ unit: { name: 'session_projcache', version: 99 }, tables: { sessions: { 'session-a': 1 } } })]) {
    await nodeFs.writeFile(f.legacy, content);
    const result = await removeProjectionCacheCopies(f.domain, 'session-a');
    assert.equal(await nodeFs.readFile(f.legacy, 'utf8'), content);
    assert.equal(result.legacyRecordRemoved, false);
    assert.equal(result.warnings[0].code, 'legacy-cache-skipped');
  }
});

test('cache artifact links and directory redirection are refused before removal', async t => {
  const f = await cacheFixture(t);
  const backup = join(f.table, 'session-a.json.bak.202610271200');
  await nodeFs.writeFile(backup, 'retained');
  const fake = { ...nodeFs, async lstat(path) {
    const stats = await nodeFs.lstat(path);
    if (path === backup) return { isFile: () => true, isSymbolicLink: () => true };
    return stats;
  } };
  await assert.rejects(removeProjectionCacheCopies(f.domain, 'session-a', fake), { code: 'unsupported-host' });
  assert.equal(await nodeFs.readFile(backup, 'utf8'), 'retained');
  f.domain.unit.dir = join(f.root, 'other-cache');
  await assert.rejects(removeProjectionCacheCopies(f.domain, 'session-a'), { code: 'unsupported-host' });
});

test('legacy write failure preserves original data and removes temporary file', async t => {
  const f = await cacheFixture(t);
  const original = JSON.stringify({ unit: { name: 'session_projcache', version: 7 }, global: null,
    tables: { sessions: { 'session-a': 'A', 'session-b': 'B' } } });
  await nodeFs.writeFile(f.legacy, original);
  const fake = { ...nodeFs, async rename() { throw new Error('simulated rename failure'); } };
  await assert.rejects(removeProjectionCacheCopies(f.domain, 'session-a', fake), /simulated rename failure/);
  assert.equal(await nodeFs.readFile(f.legacy, 'utf8'), original);
  assert.deepEqual((await nodeFs.readdir(f.root)).sort(), ['session_projcache', 'session_projcache.json']);
});

test('non-Windows hosts are rejected before modifying service methods', async () => {
  const f = fixture();
  const original = f.ctx.sessionPersistence.open;
  await assert.rejects(createHostAdapter(f.ctx, { ...f.options, platform: 'linux' }), { code: 'unsupported-host' });
  assert.equal(f.ctx.sessionPersistence.open, original);
});

// Exercise the production version verifier: real temporary manifests and Node
// package resolution, with no verifyVersion override or installed DSH access.
const hostPackages = ['dsh-agent-loop', 'dsh-session-persistence-jsonl', 'dsh-workspace',
  'dsh-session-projection-cache', 'dsh-session-query-sqlite', 'dsh-storage-domain', 'dsh-storage-json'];

async function versionFixture(t, version = '0.2.1-rc.5') {
  const f = fixture();
  const temporaryRoot = resolve(tmpdir());
  const root = await nodeFs.mkdtemp(join(temporaryRoot, 'dsh-delete-version-test-'));
  t.after(async () => {
    assert.equal(dirname(root), temporaryRoot);
    assert.match(basename(root), /^dsh-delete-version-test-[A-Za-z0-9]+$/);
    await nodeFs.rm(root, { recursive: true, force: true });
  });
  async function packages(branch, packageVersion) {
    const base = pathToFileURL(join(root, branch, 'cordis.yml')).href;
    const manifests = new Map();
    const modules = new Map();
    const entries = [];
    for (const name of hostPackages) {
      const specifier = `@deepseek-ai/${name}`;
      const dir = join(root, branch, 'node_modules', '@deepseek-ai', name);
      const manifestPath = join(dir, 'package.json');
      const modulePath = join(dir, 'lib', 'index.js');
      await nodeFs.mkdir(dirname(modulePath), { recursive: true });
      await nodeFs.writeFile(manifestPath, JSON.stringify({ name: specifier, version: packageVersion,
        type: 'module', exports: { '.': './lib/index.js', './package.json': './package.json' } }));
      await nodeFs.writeFile(modulePath, 'throw new Error("Fixture Host modules must never execute");\n');
      manifests.set(name, manifestPath);
      modules.set(specifier, pathToFileURL(modulePath).href);
      entries.push({ options: { name: specifier }, fiber: {}, parent: { tree: { ctx: { baseUrl: base } } } });
    }
    return { base, manifests, modules, entries };
  }
  const active = await packages('active', version);
  f.ctx.loader = { entries: () => active.entries };
  return { ...f, ...active, packages, options: { fs: f.fs, platform: 'win32' } };
}

async function assertVersionRefusal(f, message) {
  const originalOpen = f.ctx.sessionPersistence.open;
  const originalPut = f.ctx.sessionProjectionCache.put;
  const originalObserve = f.ctx.sessionQuery.observeSession;
  await assert.rejects(createHostAdapter(f.ctx, f.options), error => {
    assert.equal(error.code, 'unsupported-host');
    if (message) assert.match(error.message, message);
    return true;
  });
  assert.equal(f.ctx.sessionPersistence.open, originalOpen);
  assert.equal(f.ctx.sessionProjectionCache.put, originalPut);
  assert.equal(f.ctx.sessionQuery.observeSession, originalObserve);
  assert.deepEqual(f.events, []);
  assert.equal(f.onDisk(), true);
  assert.equal(f.cacheRecords.has(f.id), true);
}

for (const version of ['0.2.1-rc.3', '0.2.1-rc.5']) {
  test(`real manifests admit ${version} and retain lifecycle/lease deletion ordering`, async t => {
    const f = await versionFixture(t, version);
    const originalOpen = f.ctx.sessionPersistence.open;
    const adapter = await createHostAdapter(f.ctx, f.options);
    try {
      const result = await adapter.deleteSession(f.id);
      assert.equal(result.deleted, true);
      assert.equal(result.preservedDescendants, 1);
      assert.equal(result.sharedAttachmentsRetained, true);
      assert.deepEqual(f.events, ['archive', 'children-drain', 'lifecycle', 'cancel', 'idle', 'scope-cleanup', 'writer-close', 'detach', 'owner-release',
        'lock', 'rm', 'schedule-active', 'schedule-inactive', 'workspace-detach', 'unpin', 'unarchive', 'cache-delete', 'query-reconcile', 'lock-close', 'removed']);
      assert.deepEqual(f.scheduleTasks.map(task => task.id), ['foreign']);
    } finally { await adapter.dispose(); }
    assert.equal(f.ctx.sessionPersistence.open, originalOpen);
  });
}

test('real manifests reject unverified rc.4, stable, future and missing versions', async t => {
  for (const version of ['0.2.1-rc.4', '0.2.1', '0.2.2-rc.1', undefined]) {
    await t.test(String(version), async t => {
      const f = await versionFixture(t);
      await nodeFs.writeFile(f.manifests.get('dsh-storage-json'), JSON.stringify({ name: '@deepseek-ai/dsh-storage-json', version }));
      await assertVersionRefusal(f, /supports DSH/);
    });
  }
});

test('missing or unusable active Loader contexts fail before service mutation', async t => {
  const cases = {
    'missing loader': f => { delete f.ctx.loader; },
    'non-iterable entries': f => { f.ctx.loader.entries = () => undefined; },
    'missing package entry': f => { f.entries.pop(); },
    'inactive package entry': f => { delete f.entries.at(-1).fiber; },
    'disabled package entry': f => { f.entries.at(-1).disabled = true; },
    'missing parent context': f => { delete f.entries.at(-1).parent; },
    'missing base URL': f => { delete f.entries.at(-1).parent.tree.ctx.baseUrl; },
    'invalid base URL': f => { f.entries.at(-1).parent.tree.ctx.baseUrl = 'relative.yml'; },
  };
  for (const [label, change] of Object.entries(cases)) await t.test(label, async t => {
    const f = await versionFixture(t);
    change(f);
    await assertVersionRefusal(f);
  });
});

test('unreadable, malformed and foreign manifests are refused', async t => {
  for (const content of ['', '{broken', 'null', JSON.stringify({ name: 'foreign-package', version: '0.2.1-rc.5' })]) {
    await t.test(content || 'missing manifest export target', async t => {
      const f = await versionFixture(t);
      // For the missing case, keep the package present but make its manifest
      // export point at a nonexistent file; no destructive setup is needed.
      await nodeFs.writeFile(f.manifests.get('dsh-storage-json'), content || JSON.stringify({
        name: '@deepseek-ai/dsh-storage-json', version: '0.2.1-rc.5', exports: { './package.json': './missing.json' },
      }));
      await assertVersionRefusal(f);
    });
  }
});

test('mixed supported versions across active packages are refused in either order', async t => {
  for (const version of ['0.2.1-rc.3', '0.2.1-rc.5']) await t.test(version, async t => {
    const f = await versionFixture(t, version);
    const other = version === '0.2.1-rc.3' ? '0.2.1-rc.5' : '0.2.1-rc.3';
    await nodeFs.writeFile(f.manifests.get('dsh-storage-json'), JSON.stringify({ name: '@deepseek-ai/dsh-storage-json', version: other }));
    await assertVersionRefusal(f, /Mixed active DSH package versions/);
  });
});

test('a later duplicate active package cannot hide a mixed Loader tree', async t => {
  const f = await versionFixture(t);
  const other = await f.packages('other-tree', '0.2.1-rc.3');
  f.entries.push(other.entries[0]);
  await assertVersionRefusal(f, /Mixed active DSH package versions/);
});

test('same-version active copies are allowed and inactive copies do not select a version', async t => {
  const f = await versionFixture(t);
  const same = await f.packages('same-version', '0.2.1-rc.5');
  const unknown = await f.packages('inactive-version', '0.2.1-rc.4');
  const disabled = { ...unknown.entries[1], disabled: true };
  const inactive = { ...unknown.entries[0], fiber: undefined };
  f.entries.unshift(disabled, inactive);
  f.entries.push(same.entries[0]);
  const adapter = await createHostAdapter(f.ctx, f.options);
  await adapter.dispose();
  assert.deepEqual(f.events, []);
});

for (const version of ['v1', 'v2']) {
  test(`Loader ${version} resolution checks the imported package instead of a require-resolved copy`, async t => {
    for (const accepted of [true, false]) await t.test(accepted ? 'supported imported copy' : 'unsupported imported copy', async t => {
      const f = await versionFixture(t, accepted ? '0.2.1-rc.4' : '0.2.1-rc.5');
      const imported = await f.packages('esm-imported', accepted ? '0.2.1-rc.5' : '0.2.1-rc.4');
      const calls = [];
      const internal = { version, resolveSync(...args) {
        assert.equal(this, internal);
        const [specifier, base, attributes] = version === 'v1' ? args : [args[1].specifier, args[0], args[1].attributes];
        assert.equal(base, f.base);
        assert.deepEqual(attributes, {});
        assert.equal(args.length, version === 'v1' ? 3 : 2);
        calls.push(specifier);
        return { url: imported.modules.get(specifier) };
      } };
      f.ctx.loader.internal = internal;
      if (accepted) {
        const adapter = await createHostAdapter(f.ctx, f.options);
        await adapter.dispose();
        assert.deepEqual(calls, hostPackages.map(name => `@deepseek-ai/${name}`));
      } else {
        await assertVersionRefusal(f, /reports 0\.2\.1-rc\.4/);
        assert.equal(calls.length, 1);
      }
    });
  });
}

test('unknown or failing internal resolvers never fall back to supported require manifests', async t => {
  let unknownCalls = 0;
  const cases = {
    'unknown signature': { version: 'v3', resolveSync() { unknownCalls++; return undefined; } },
    'missing resolver': { version: 'v2' },
    'resolution failure': { version: 'v2', resolveSync() { throw new Error('Cannot resolve imported module'); } },
    'non-file module': { version: 'v2', resolveSync() { return { url: 'data:text/javascript,export{}' }; } },
    'missing resolution': { version: 'v1', resolveSync() { return undefined; } },
  };
  for (const [label, internal] of Object.entries(cases)) await t.test(label, async t => {
    const f = await versionFixture(t);
    f.ctx.loader.internal = internal;
    await assertVersionRefusal(f, /Cannot resolve/);
  });
  assert.equal(unknownCalls, 0, 'Unknown resolver signatures must be rejected without invocation');
});

test('supported real versions still refuse unknown service and lifecycle structures', async t => {
  for (const version of ['0.2.1-rc.3', '0.2.1-rc.5']) await t.test(version, async t => {
    const f = await versionFixture(t, version);
    const observations = f.ctx.sessionQuery._observations;
    f.ctx.sessionQuery._observations = { ...observations, cache: {} };
    await assertVersionRefusal(f, /bookkeeping/);
    f.ctx.sessionQuery._observations = observations;
    f.disposer[EFFECT].label = 'unverified-lifecycle';
    const adapter = await createHostAdapter(f.ctx, f.options);
    try {
      await assert.rejects(adapter.deleteSession(f.id), { code: 'unsupported-host' });
      assert.deepEqual(f.events, []);
      assert.equal(f.onDisk(), true);
    } finally { await adapter.dispose(); }
  });
});
