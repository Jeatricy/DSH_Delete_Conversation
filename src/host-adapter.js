import * as nodeFs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

// Compatibility adapter for the verified DSH 0.2.1-rc.3 and rc.5 implementations.
// DSH has no session-delete API.
// Private boundaries used deliberately: labeled Cordis lifecycle disposer,
// JSONL tracker/cache, projection-cache write admission, query reconciliation,
// and workspace's header-only indexes. Never synthesize lifecycle events.
export const SUPPORTED_DSH_VERSIONS = Object.freeze(['0.2.1-rc.3', '0.2.1-rc.5']);
const ORIGINAL = Symbol.for('cordis.original');
const EFFECT = Symbol.for('cordis.effect');
const PACKAGES = ['dsh-agent-loop', 'dsh-session-persistence-jsonl', 'dsh-workspace',
  'dsh-session-projection-cache', 'dsh-session-query-sqlite', 'dsh-storage-domain', 'dsh-storage-json'];
const concrete = value => value?.[ORIGINAL] ?? value;

export class DeleteSessionError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'DeleteSessionError';
    this.code = code;
  }
}
function refuse(message) { throw new DeleteSessionError('unsupported-host', message); }
function method(object, name) {
  if (typeof object?.[name] !== 'function') refuse(`Unsupported DSH adapter: missing ${name}().`);
}
function sessionId(value) {
  // Normal generated ids and safe configured ids; no path encoding guesses.
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) {
    throw new DeleteSessionError('invalid-session-id', 'Invalid or unsupported conversation id.');
  }
  return value;
}

async function activePackageManifest(loader, base, specifier) {
  const internal = loader.internal;
  if (internal === undefined) {
    // Same fallback as DSH client-modules when Node's internal loader is absent.
    const require = createRequire(base);
    return JSON.parse(await nodeFs.readFile(require.resolve(`${specifier}/package.json`), 'utf8'));
  }
  // Follow the resolver that imports the Host module, including ESM hooks.
  // A failing/unknown internal resolver must never fall back to a different copy.
  method(internal, 'resolveSync');
  if (!['v1', 'v2'].includes(internal.version)) refuse('Unsupported DSH Loader resolver version.');
  const resolved = internal.version === 'v2'
    ? internal.resolveSync(base, { specifier, attributes: {} })
    : internal.resolveSync(specifier, base, {});
  if (typeof resolved?.url !== 'string' || !resolved.url.startsWith('file:')) {
    refuse(`Cannot locate the active ${specifier} module on disk.`);
  }
  let dir = dirname(fileURLToPath(resolved.url));
  while (true) {
    let manifest;
    try { manifest = JSON.parse(await nodeFs.readFile(join(dir, 'package.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (manifest?.name === specifier) return manifest;
    const parent = dirname(dir);
    if (parent === dir) refuse(`Cannot find the active ${specifier} package manifest.`);
    dir = parent;
  }
}

async function verifyHostVersion(ctx) {
  method(ctx?.loader, 'entries');
  const loader = ctx.loader;
  let entries;
  try { entries = [...loader.entries()]; }
  catch (cause) { throw new DeleteSessionError('unsupported-host', 'Cannot inspect active DSH Loader entries.', { cause }); }
  let hostVersion;
  for (const name of PACKAGES) {
    const specifier = `@deepseek-ai/${name}`;
    const active = entries.filter(item => item?.options?.name === specifier && item.fiber && !item.disabled);
    if (!active.length) refuse(`Cannot verify the active ${specifier} package.`);
    // Nested Loader trees can mount multiple copies. Checking only the first
    // would hide a mixed or unverified implementation in another active tree.
    for (const entry of active) {
      const base = entry.parent?.tree?.ctx?.baseUrl;
      if (!base) refuse(`Cannot verify the active ${specifier} package.`);
      let manifest;
      try { manifest = await activePackageManifest(loader, base, specifier); }
      catch (cause) {
        throw new DeleteSessionError('unsupported-host', `Cannot resolve ${specifier} from its active Loader context.`, { cause });
      }
      if (manifest?.name !== specifier || !SUPPORTED_DSH_VERSIONS.includes(manifest?.version)) {
        refuse(`Conversation deletion supports DSH ${SUPPORTED_DSH_VERSIONS.join(' or ')}; ${specifier} reports ${manifest?.version}.`);
      }
      if (hostVersion !== undefined && manifest.version !== hostVersion) {
        refuse(`Mixed active DSH package versions are unsupported: expected ${hostVersion}; ${specifier} reports ${manifest.version}.`);
      }
      hostVersion = manifest.version;
    }
  }
}

/** Find the exact existing outer lifecycle, not agent.scope.dispose(). */
export function findLifecycleDisposer(agent, agents, sessions) {
  if (!agent || agents.get(agent.id) !== agent || sessions.get(agent.id) !== agent.session) {
    refuse('The conversation lifecycle changed before deletion.');
  }
  const fiber = agent.loopCtx?.fiber;
  if (!fiber?._disposables?.[Symbol.iterator] || agent.ctx?.fiber !== agent.scope?.ctx?.fiber) {
    refuse('The Agent is not the supported ReactLoopAgent lifecycle.');
  }
  const label = `agentLoop.scope(${agent.id})`;
  const matches = [...fiber._disposables].filter(dispose => typeof dispose === 'function' && dispose[EFFECT]?.label === label);
  if (matches.length !== 1 || !matches[0][EFFECT].children?.some(child => child.label === 'ctx.plugin()')) {
    refuse('Cannot identify one exact conversation lifecycle disposer.');
  }
  const registry = agent.loopCtx.registry;
  if (typeof registry?.values !== 'function') refuse('Cannot inspect the conversation owner lifecycle.');
  const ownerLabel = `agentLoop.lifecycle(${agent.id})`;
  const owners = [];
  for (const runtime of registry.values()) for (const ownerFiber of runtime.fibers ?? []) {
    for (const dispose of ownerFiber._disposables ?? []) {
      if (typeof dispose === 'function' && dispose[EFFECT]?.label === ownerLabel) owners.push(dispose);
    }
  }
  if (owners.length !== 1) refuse('Cannot identify one exact conversation owner lifecycle.');
  return async () => {
    await matches[0]();
    // The same memoized teardown is already complete. This removes the owner
    // wrapper so it cannot retain the deleted Agent and history in a closure.
    await owners[0]();
  };
}

/** Verify a session artifact directory under the actual configured JSONL root. */
export async function checkedSessionDirectory(persistence, header, fs = nodeFs) {
  const root = resolve(persistence.root);
  const location = persistence.locate(header);
  if (location?.kind !== 'jsonl' || !isAbsolute(location.path)) refuse('Only the installed JSONL backend is supported.');
  const dir = dirname(resolve(location.path));
  const parts = relative(root, dir).split(sep);
  if (parts.length !== 2 || parts.some(part => !part || part === '.' || part === '..') || basename(dir) !== sessionId(header.id)) {
    refuse('The conversation artifact is outside its expected storage directory.');
  }
  for (const path of [root, dirname(dir), dir]) {
    let stats;
    try { stats = await fs.lstat(path); } catch (error) {
      if (error.code === 'ENOENT') return { root, dir, exists: false };
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) refuse('Refusing a redirected conversation storage directory.');
  }
  const canonicalRoot = await fs.realpath(root);
  if (await fs.realpath(dir) !== join(canonicalRoot, ...parts)) refuse('The conversation storage path changed during validation.');
  return { root, dir, exists: true };
}

function projectionCachePaths(domain) {
  const unit = domain?.unit;
  const descriptor = unit?.descriptor;
  if (descriptor?.name !== 'session_projcache' || descriptor.layout !== 'per-record' ||
      !Array.isArray(descriptor.tables) || !descriptor.tables.includes('sessions') ||
      !Number.isSafeInteger(descriptor.version) || typeof unit.dir !== 'string' || !isAbsolute(unit.dir)) {
    refuse('Projection-cache cleanup requires the supported active JSON per-record provider.');
  }
  const dir = resolve(unit.dir);
  if (basename(dir) !== 'session_projcache') refuse('Unexpected projection-cache storage directory.');
  const root = dirname(dir);
  return { root, dir, table: join(dir, 'sessions'), legacy: join(root, 'session_projcache.json'),
    versions: [descriptor.version, ...(descriptor.compatibleVersions ?? [])] };
}

async function checkedCachePaths(domain, fs) {
  const paths = projectionCachePaths(domain);
  let rootExists = false;
  let tableExists = false;
  let canonicalRoot;
  for (const path of [paths.root, paths.dir, paths.table]) {
    let stats;
    try { stats = await fs.lstat(path); } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) refuse('Refusing a redirected projection-cache directory.');
    const canonical = await fs.realpath(path);
    if (path === paths.root) { canonicalRoot = canonical; rootExists = true; }
    else if (canonical !== join(canonicalRoot, relative(paths.root, path))) refuse('Projection-cache path escaped its storage root.');
    if (path === paths.table) tableExists = true;
  }
  return { ...paths, rootExists, tableExists, canonicalRoot };
}

async function assertCacheFile(path, canonicalParent, fs) {
  const stats = await fs.lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || await fs.realpath(path) !== join(canonicalParent, basename(path))) {
    refuse('Refusing a redirected or non-file projection-cache artifact.');
  }
}

/**
 * Remove copies belonging to one id from the active JSON cache provider.
 * Caller runs this on projectionDomain.enqueue after the public row deletion.
 * Foreign legacy formats are retained and reported instead of guessed.
 */
export async function removeProjectionCacheCopies(domain, value, fs = nodeFs) {
  const id = sessionId(value);
  const paths = await checkedCachePaths(domain, fs);
  const result = { backupFilesRemoved: 0, legacyRecordRemoved: false, warnings: [] };
  if (paths.tableExists) {
    const prefix = `${id}.json.bak.`;
    for (const entry of await fs.readdir(paths.table, { withFileTypes: true })) {
      if (!entry.name.startsWith(prefix) || !/^\d{12}$/.test(entry.name.slice(prefix.length))) continue;
      const path = join(paths.table, entry.name);
      // A whole segment and the exact DSH backup timestamp are required; no
      // wildcard prefix deletion that could remove a similarly named session.
      try {
        const checked = await checkedCachePaths(domain, fs);
        if (!checked.tableExists) continue;
        await assertCacheFile(path, join(checked.canonicalRoot, 'session_projcache', 'sessions'), fs);
        await fs.rm(path, { force: true });
        result.backupFilesRemoved += 1;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  if (!paths.rootExists) return result;
  let text;
  try {
    await assertCacheFile(paths.legacy, paths.canonicalRoot, fs);
    text = await fs.readFile(paths.legacy, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return result; throw error; }
  const recordObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  let document;
  try { document = JSON.parse(text); } catch { /* A malformed shared file cannot be attributed safely. */ }
  if (!recordObject(document) || !recordObject(document.unit) || document.unit.name !== 'session_projcache' ||
      !paths.versions.includes(document.unit.version) || !recordObject(document.tables) ||
      (document.tables.sessions !== undefined && !recordObject(document.tables.sessions))) {
    result.warnings.push({ code: 'legacy-cache-skipped', message: 'An unsupported or malformed shared legacy projection cache was retained.' });
    return result;
  }
  if (!Object.hasOwn(document.tables.sessions ?? {}, id)) return result;
  delete document.tables.sessions[id];
  const updated = `${JSON.stringify(document, null, 2)}\n`;
  const temporary = join(paths.root, `.dsh-delete-cache-${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    created = true;
    try { await handle.writeFile(updated, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    const checked = await checkedCachePaths(domain, fs);
    if (!checked.rootExists) throw new DeleteSessionError('cache-changed', 'Projection-cache directory changed during cleanup.');
    await assertCacheFile(paths.legacy, checked.canonicalRoot, fs);
    if (await fs.readFile(paths.legacy, 'utf8') !== text) {
      throw new DeleteSessionError('cache-changed', 'Shared legacy projection cache changed during cleanup; retry deletion.');
    }
    // Same-directory atomic replacement; every unrelated table, record, global
    // value and header field survives. Never write a backup containing the id.
    await fs.rename(temporary, paths.legacy);
    created = false;
    result.legacyRecordRemoved = true;
    return result;
  } finally { if (created) await fs.rm(temporary, { force: true }); }
}

/**
 * Create once in the host plugin; dispose before withdrawing its dependencies.
 * `verifyVersion`/`fs`/`platform` are test seams, never wire-request options.
 * The caller MUST authorize the owner principal before calling deleteSession.
 */
export async function createHostAdapter(ctx, options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') refuse('Conversation deletion currently supports Windows only.');
  await (options.verifyVersion ?? verifyHostVersion)(ctx);
  const fs = options.fs ?? nodeFs;
  const agents = concrete(ctx.agents);
  const sessions = concrete(ctx.sessions);
  const persistence = concrete(ctx.sessionPersistence);
  const workspace = concrete(ctx.workspaceRegistry);
  const cache = concrete(ctx.sessionProjectionCache);
  const query = concrete(ctx.sessionQuery);
  const domains = concrete(ctx.storageDomain);
  const schedule = concrete(ctx.get?.('schedule'));
  const subagents = concrete(ctx.get?.('subagents'));
  const spill = concrete(ctx.get?.('spill'));
  const controller = concrete(ctx.get?.('sessionController'));
  for (const [object, names] of [[agents, ['get', 'list', 'enter']], [sessions, ['get', 'enter']],
    [persistence, ['open', 'create', 'stat', 'list', 'locate', 'memoizeStoredLog']],
    [workspace, ['archiveSession', 'unarchiveSession', 'unpinSession', 'list']],
    [cache, ['put']], [query, ['observeSession', '_serialized', '_ensureReady', '_reconcile']],
    [domains, ['get']]]) for (const name of names) method(object, name);
  if (!(persistence.tracker?.writers instanceof Map) || !(persistence.coldLogMemo instanceof Map) ||
      !(query._observations?.cache instanceof Map) || typeof query._observations?.store !== 'function' || typeof persistence.root !== 'string') refuse('Unsupported persistence or query bookkeeping.');
  const projectionDomain = domains.get('session_projcache');
  if (!projectionDomain?.table || !projectionDomain.table('sessions')?.delete) refuse('Projection cache domain is unavailable.');
  method(projectionDomain, 'enqueue');
  projectionCachePaths(projectionDomain);
  for (const name of ['headers', 'sessionPaths', 'missingSessionPaths', 'invalidSessionPaths']) {
    if (typeof workspace[name]?.delete !== 'function') refuse(`Unsupported workspace index ${name}.`);
  }
  if (schedule) for (const name of ['catalog', 'delete', 'create', 'update', 'serialize']) method(schedule, name);
  if (subagents) method(subagents, 'drainDescendants');

  const pending = new Map();
  const blocked = new Set();
  const completed = new Map();
  const recovery = new Map();
  const undo = [];
  let closed = false;
  const deletedError = id => new DeleteSessionError('session-deleting', `Conversation ${id} is being deleted or has been deleted.`);
  function admit(id) { if (blocked.has(id)) throw deletedError(id); }
  function patch(object, name, make) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    const original = object[name];
    const replacement = make(original);
    Object.defineProperty(object, name, { value: replacement, configurable: true, writable: true });
    undo.push(() => {
      if (object[name] !== replacement) return;
      if (descriptor) Object.defineProperty(object, name, descriptor);
      else delete object[name];
    });
    return original;
  }
  // Preserve receiver contexts: Cordis traces service method calls through `this`.
  let openOriginal, statOriginal, listOriginal;
  try {
    openOriginal = patch(persistence, 'open', original => function(id, ...args) { admit(id); return Reflect.apply(original, this, [id, ...args]); });
    patch(persistence, 'create', original => function(header, ...args) { admit(header.id); return Reflect.apply(original, this, [header, ...args]); });
    statOriginal = patch(persistence, 'stat', original => async function(id, ...args) {
      if (blocked.has(id)) return undefined;
      const result = await Reflect.apply(original, this, [id, ...args]);
      return blocked.has(id) ? undefined : result;
    });
    listOriginal = patch(persistence, 'list', original => async function(...args) {
      return (await Reflect.apply(original, this, args)).filter(row => !blocked.has(row.header.id));
    });
    for (const object of [agents, sessions]) patch(object, 'enter', original => function(value, ...args) {
      admit(value.id); return Reflect.apply(original, this, [value, ...args]);
    });
    patch(persistence, 'memoizeStoredLog', original => function(id, ...args) {
      if (!blocked.has(id)) return Reflect.apply(original, this, [id, ...args]);
    });
    patch(cache, 'put', original => function(id, ...args) {
      return blocked.has(id) ? Promise.resolve() : Reflect.apply(original, this, [id, ...args]);
    });
    patch(query._observations, 'store', original => function(id, ...args) {
      if (!blocked.has(id)) return Reflect.apply(original, this, [id, ...args]);
    });
    patch(query, 'observeSession', original => async function(id, ...args) {
      admit(id);
      const observation = await Reflect.apply(original, this, [id, ...args]);
      if (blocked.has(id)) { observation[Symbol.dispose]?.(); throw deletedError(id); }
      return observation;
    });
    if (controller?.agents && typeof controller.agents.resolve === 'function') patch(controller.agents, 'resolve', original => function(id, ...args) {
      admit(id); return Reflect.apply(original, this, [id, ...args]);
    });
    if (schedule) {
      patch(schedule, 'create', original => function(id, ...args) { admit(id); return Reflect.apply(original, this, [id, ...args]); });
      patch(schedule, 'update', original => function(request, ...args) { admit(request.sessionId); return Reflect.apply(original, this, [request, ...args]); });
    }
    if (ctx.on) undo.push(ctx.on('agent/pre-step', (payload, next) => blocked.has(payload.agent.id) ? Promise.resolve({ kind: 'reject' }) : next()));
  } catch (error) {
    for (const restore of undo.reverse()) restore();
    throw error;
  }

  async function removeSpills(id, headers) {
    if (!spill || typeof spill.root !== 'string') return;
    const hash = createHash('sha256').update(id).digest('hex').slice(0, 12);
    if (headers.some(row => row.header.id !== id && createHash('sha256').update(row.header.id).digest('hex').slice(0, 12) === hash)) return;
    // Only the active provider's root establishes ownership. Other temp roots
    // can belong to a different profile or process with the same session id.
    const roots = [resolve(spill.root)];
    for (const root of roots) {
      const target = join(root, `session-${hash}`);
      try {
        const [rootStat, targetStat] = await Promise.all([fs.lstat(root), fs.lstat(target)]);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !targetStat.isDirectory() || targetStat.isSymbolicLink()) continue;
        if (await fs.realpath(target) !== join(await fs.realpath(root), `session-${hash}`)) continue;
        await fs.rm(target, { recursive: true, force: true });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  async function cleanupMetadata(id, plan) {
    if (schedule) {
      // Management and delivery share this queue; finish pre-gate creates first.
      await schedule.serialize(async () => {});
      // Catalog includes inactive rows and their stored delivery histories.
      for (const task of await schedule.catalog()) if (task.sessionId === id) await schedule.delete({ sessionId: id, id: task.id });
    }
    for (const entity of workspace.list()) await entity.detachSession(id);
    await workspace.unpinSession(id);
    await workspace.unarchiveSession(id);
    for (const name of ['headers', 'sessionPaths', 'missingSessionPaths', 'invalidSessionPaths']) workspace[name].delete(id);
    // Domain writes are queued: this deletion follows writes admitted before the gate.
    await projectionDomain.table('sessions').delete(id);
    const cacheCopies = await projectionDomain.enqueue(() => removeProjectionCacheCopies(projectionDomain, id, fs));
    persistence.coldLogMemo.delete(id);
    query._observations.cache.delete(id);
    // Disabled in-memory search has no retained index. An on-disk index must be purged even if search is disabled.
    if (query._ready !== undefined || (query.config?.path && query.config.path !== ':memory:')) {
      await query._serialized(undefined, async () => { await query._ensureReady(undefined); await query._reconcile(undefined); });
    }
    await removeSpills(id, plan.headers);
    return cacheCopies;
  }
  async function perform(id) {
    let plan = recovery.get(id);
    if (!plan) {
      const live = agents.get(id);
      const attached = sessions.get(id);
      if (attached && !live) refuse('An attached conversation has no supported owning Agent.');
      const disposer = live ? findLifecycleDisposer(live, agents, sessions) : undefined;
      // Preflight storage and lifecycle before archiving/stopping anything.
      const snapshot = await Reflect.apply(statOriginal, persistence, [id]);
      const header = live?.session.header ?? snapshot?.header;
      if (!header) throw new DeleteSessionError('session-not-found', 'Conversation does not exist.');
      if (header.origin === 'subagent') throw new DeleteSessionError('child-session', 'Delete the parent conversation from its conversation menu; direct child deletion is unsupported.');
      const directory = await checkedSessionDirectory(persistence, header, fs);
      await checkedCachePaths(projectionDomain, fs);
      const headers = await Reflect.apply(listOriginal, persistence, []);
      const descendants = new Set([id]);
      let changed;
      do {
        changed = false;
        for (const row of headers) if (descendants.has(row.header.parentSession) && !descendants.has(row.header.id)) {
          descendants.add(row.header.id); changed = true;
        }
      } while (changed);
      plan = { header, directory, headers, descendants: descendants.size - 1, removed: false };
      blocked.add(id);
      let restoreSend;
      try {
        // Recheck after asynchronous preflight; another resume may have become live.
        if (agents.get(id) !== live || sessions.get(id) !== attached) throw new DeleteSessionError('session-busy', 'Conversation changed during deletion; retry.');
        if (live) {
          patch(live, 'send', original => function(...args) { admit(id); return Reflect.apply(original, this, args); });
          restoreSend = undo.at(-1);
        }
        if (live) {
          await workspace.archiveSession(id, { stopActivity: true });
          if (subagents) await subagents.drainDescendants([live]);
          await disposer();
        }
        if (agents.get(id) || sessions.get(id) || persistence.tracker.writers.has(id)) {
          throw new DeleteSessionError('session-busy', 'Conversation resources have not finished stopping.');
        }
      } catch (error) { blocked.delete(id); throw error; }
      finally {
        if (restoreSend) {
          restoreSend();
          const at = undo.indexOf(restoreSend);
          if (at >= 0) undo.splice(at, 1);
        }
      }
      recovery.set(id, plan);
    }
    let handle;
    try {
      const snapshot = await Reflect.apply(statOriginal, persistence, [id]);
      if (snapshot) handle = await Reflect.apply(openOriginal, persistence, [id, 'write']);
      else if (!plan.removed && plan.directory.exists) throw new DeleteSessionError('session-changed', 'Conversation storage disappeared during deletion; retry after restarting DSH.');
      // Never flush or append through this deletion handle. It retains exclusive ownership only.
      const current = await checkedSessionDirectory(persistence, plan.header, fs);
      plan.removed = true; // rm can fail after a partial removal; keep the gate and retry plan.
      if (current.exists) await fs.rm(current.dir, { recursive: true, force: true });
      const cacheCopies = await cleanupMetadata(id, plan);
      await handle?.close();
      handle = undefined;
      const result = { sessionId: id, deleted: true, preservedDescendants: plan.descendants, sharedAttachmentsRetained: true,
        cacheBackupsRemoved: cacheCopies.backupFilesRemoved, legacyCacheRecordRemoved: cacheCopies.legacyRecordRemoved,
        ...(cacheCopies.warnings.length ? { warnings: cacheCopies.warnings } : {}) };
      for (const warning of cacheCopies.warnings) ctx.logger?.warn?.(warning.message);
      completed.set(id, result);
      recovery.delete(id);
      try { ctx.emit('api-session/removed', id); } catch (error) {
        ctx.logger?.warn?.(`Conversation deleted, but removal notification failed: ${String(error)}`);
      }
      return result;
    } catch (cause) {
      if (!plan.removed) { blocked.delete(id); recovery.delete(id); throw cause; }
      throw new DeleteSessionError('cleanup-incomplete', 'Conversation deletion started, but cleanup did not finish. Retry deletion to complete it.', { cause });
    } finally { await handle?.close(); }
  }
  return {
    deleteSession(value) {
      const id = sessionId(value);
      if (closed) return Promise.reject(new DeleteSessionError('adapter-stopping', 'Deletion plugin is stopping.'));
      if (completed.has(id)) return Promise.resolve(completed.get(id));
      if (pending.has(id)) return pending.get(id);
      const operation = perform(id).finally(() => pending.delete(id));
      pending.set(id, operation);
      return operation;
    },
    isDeleted(id) { return blocked.has(id); },
    async dispose() {
      closed = true;
      await Promise.allSettled([...pending.values()]);
      for (const restore of undo.reverse()) restore();
    }
  };
}
