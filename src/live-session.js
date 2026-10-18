const EFFECT = Symbol.for('cordis.effect')
const SUPPORTED_RUNTIMES = new Set(['0.2.0-rc.2', '0.2.1-rc.2'])
const releases = new WeakSet()
const runtimeVersionTasks = new WeakMap()

export class LiveSessionError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'LiveSessionError'
    this.code = code
  }
}

async function runtimeVersion(ctx) {
  let loader
  try { loader = ctx?.get?.('loader') } catch {}
  if (loader !== null && typeof loader === 'object' && typeof loader.import === 'function') {
    let task = runtimeVersionTasks.get(loader)
    if (task === undefined) {
      task = Promise.resolve().then(() => loader.import('@deepseek-ai/dsh-app-boot'))
        .then(appBoot => appBoot.getDshRuntimeVersion(), () => undefined)
      runtimeVersionTasks.set(loader, task)
    }
    return task
  }
  try {
    const appBoot = await import('@deepseek-ai/dsh-app-boot')
    return appBoot.getDshRuntimeVersion()
  } catch {
    return undefined
  }
}

function lookup(registry, id) {
  if (registry === null || typeof registry !== 'object' || typeof registry.get !== 'function') return { known: false }
  try {
    return { known: true, value: registry.get(id) }
  } catch {
    return { known: false }
  }
}

function contextFibers(ctx) {
  const root = ctx?.root
  if (root === null || typeof root !== 'object' || root.registry === null || typeof root.registry?.values !== 'function') return undefined
  const fibers = new Set()
  if (root.fiber !== undefined) fibers.add(root.fiber)
  if (ctx.fiber !== undefined) fibers.add(ctx.fiber)
  try {
    for (const runtime of root.registry.values()) {
      if (runtime?.fibers === null || runtime?.fibers === undefined || typeof runtime.fibers[Symbol.iterator] !== 'function') continue
      for (const fiber of runtime.fibers) fibers.add(fiber)
    }
  } catch {
    return undefined
  }
  return [...fibers]
}

function lifecycleDisposers(ctx, agent, id, version) {
  const ownerFibers = contextFibers(ctx)
  const scopeDisposer = agent?.ctx?.fiber?.dispose
  const scopeMeta = typeof scopeDisposer === 'function' ? scopeDisposer[EFFECT] : undefined
  if (ownerFibers === undefined || scopeMeta === undefined || !Array.isArray(scopeMeta.children)) return undefined

  if (!SUPPORTED_RUNTIMES.has(version)) return undefined
  const label = `agentLoop.lifecycle(${id})`
  const matches = []
  const scopes = []
  for (const fiber of ownerFibers) {
    if (fiber === null || typeof fiber !== 'object' || fiber.uid === null || fiber.state === 5) continue
    const disposables = fiber._disposables
    if (disposables === null || disposables === undefined || typeof disposables[Symbol.iterator] !== 'function') continue
    for (const dispose of disposables) {
      if (typeof dispose !== 'function') continue
      const effect = dispose[EFFECT]
      if (effect?.label === label) matches.push({ fiber, dispose })
      if (effect?.label === `agentLoop.scope(${id})` && Array.isArray(effect.children)
        && effect.children.length === 1 && effect.children[0] === scopeMeta) scopes.push({ fiber, dispose })
    }
  }
  if (matches.length !== 1) return matches
  const lifecycle = matches[0].dispose[EFFECT]
  if (!Array.isArray(lifecycle.children)) return undefined
  if (version === '0.2.0-rc.2') {
    return lifecycle.children.includes(scopeMeta) ? matches : undefined
  }
  // 0.2.1 splits factory-owned scope cleanup from caller-owned lifecycle
  // teardown. Match both exact identities before invoking the lifecycle;
  // disposing the scope alone would leave its writer and registrations alive.
  if (agent.scope?.ctx?.fiber !== agent.ctx.fiber || agent.scope?.rawDispose !== scopeDisposer
    || scopes.length !== 1 || scopes[0].fiber !== agent.loopCtx?.fiber
    || lifecycle.children.length !== 0) return undefined
  return matches
}

function pendingInput(agent) {
  const inbox = agent?.inbox
  if (inbox === null || typeof inbox !== 'object') return { known: false }
  try {
    const { nextTurn, nextStep } = inbox
    if (!Array.isArray(nextTurn) || !Array.isArray(nextStep)) return { known: false }
    return { known: true, count: nextTurn.length + nextStep.length }
  } catch {
    return { known: false }
  }
}

function inspectPair(ctx, id, version) {
  const agents = lookup(ctx?.agents, id)
  const sessions = lookup(ctx?.sessions, id)
  if (!agents.known || !sessions.known) {
    return { active: Boolean(agents.value || sessions.value), canRelease: false, busy: false, reason: 'unsupported' }
  }
  try {
    const agent = agents.value
    const session = sessions.value
    const active = agent !== undefined || session !== undefined
    if (!active) return { active: false, canRelease: false, busy: false, reason: 'inactive' }
    if (agent === undefined) return { active: true, canRelease: false, busy: false, reason: 'unsupported' }
    if (session === undefined || agent.id !== id || agent.session?.id !== id || agent.session !== session) {
      return { active: true, canRelease: false, busy: false, reason: 'unsupported' }
    }
    if (agent.status === 'running' || agent.phase?.kind === 'running' || agent.phase?.kind === 'maintenance') {
      return { active: true, canRelease: false, busy: true, reason: 'agent-busy' }
    }
    if (agent.status !== 'idle' || agent.phase?.kind !== 'idle') return { active: true, canRelease: false, busy: false, reason: 'unsupported' }
    const pending = pendingInput(agent)
    if (!pending.known) return { active: true, canRelease: false, busy: false, reason: 'unsupported' }
    if (pending.count !== 0) return { active: true, canRelease: false, busy: true, reason: 'queued-input' }
    const matches = lifecycleDisposers(ctx, agent, id, version)
    if (matches === undefined || matches.length !== 1) return { active: true, canRelease: false, busy: false, reason: 'unsupported' }
    if (typeof ctx.sessionPersistence?.open !== 'function') {
      return { active: true, canRelease: false, busy: false, reason: 'unsupported' }
    }
    return { active: true, canRelease: true, busy: false, reason: undefined, agent, session, ...matches[0] }
  } catch {
    return { active: true, canRelease: false, busy: false, reason: 'unsupported' }
  }
}

/** Read the verified runtime's live Agent/session ownership without changing it. */
export async function inspectLiveSession(ctx, id) {
  if (typeof id !== 'string' || id.trim() === '') {
    return { active: false, canRelease: false, busy: false, reason: 'unsupported' }
  }
  const version = await runtimeVersion(ctx)
  const { agent: _agent, session: _session, fiber: _fiber, dispose: _dispose, ...result } = inspectPair(ctx, id, version)
  return result
}

function defineFence(target, key, shouldBlock, restore) {
  const original = target?.[key]
  if (typeof original !== 'function') return false
  const own = Object.getOwnPropertyDescriptor(target, key)
  if (own !== undefined && !own.configurable && !own.writable) throw new Error(`cannot fence live session method ${key}`)
  if (own === undefined && !Object.isExtensible(target)) throw new Error(`cannot fence live session method ${key}`)
  const wrapped = function (...args) {
    if (shouldBlock(args)) throw new LiveSessionError('release-in-progress', 'session input is temporarily fenced for workspace migration')
    return Reflect.apply(original, this, args)
  }
  Object.defineProperty(target, key, {
    configurable: own?.configurable ?? true,
    enumerable: own?.enumerable ?? false,
    writable: own?.writable ?? true,
    value: wrapped,
  })
  restore.push(() => {
    if (own === undefined) delete target[key]
    else Object.defineProperty(target, key, own)
  })
  return true
}

function fenceInputs(agent) {
  const restore = []
  try {
    for (const key of ['send', 'followup', 'steer', 'inject', 'runMaintenance']) {
      if (!defineFence(agent, key, () => true, restore)) throw new Error(`live Agent does not expose ${key}`)
    }
    const inbox = agent.inbox
    const inserts = () => true
    for (const key of ['append', 'prepend', 'replace']) {
      if (!defineFence(inbox, key, inserts, restore)) throw new Error(`live Inbox does not expose ${key}`)
    }
    for (const key of ['splice', 'mutate']) {
      if (!defineFence(inbox, key, args => !Array.isArray(args[3]) || args[3].length !== 0, restore)) {
        throw new Error(`live Inbox does not expose ${key}`)
      }
    }
  } catch (error) {
    for (const undo of restore.reverse()) {
      try { undo() } catch {}
    }
    const fenceError = new LiveSessionError('input-fence-unsupported', 'the exact Native Agent and Inbox cannot be fenced safely')
    fenceError.cause = error
    throw fenceError
  }
  let restored = false
  return () => {
    if (restored) return
    restored = true
    for (const undo of restore.reverse()) undo()
  }
}

function requireIdleAndEmpty(agent) {
  if (agent.status === 'running' || agent.phase?.kind === 'running' || agent.phase?.kind === 'maintenance') {
    throw new LiveSessionError('agent-busy', 'live session became active during workspace migration')
  }
  if (agent.status !== 'idle' || agent.phase?.kind !== 'idle') throw new LiveSessionError('unsupported', 'Native Agent idle state cannot be verified')
  const pending = pendingInput(agent)
  if (!pending.known) throw new LiveSessionError('unsupported', 'live session inbox state cannot be verified')
  if (pending.count !== 0) throw new LiveSessionError('queued-input', 'live session has queued input')
}

/** Drain and release one exact idle Native Agent lifecycle without unloading its owner fiber. */
export async function releaseLiveSession(ctx, id) {
  if (typeof id !== 'string' || id.trim() === '') throw new LiveSessionError('unsupported', 'session id must be non-empty')
  const version = await runtimeVersion(ctx)
  if (!SUPPORTED_RUNTIMES.has(version)) throw new LiveSessionError('unsupported', 'live Agent release requires a verified DSH runtime')
  // The version lookup yields to the event loop; re-check all ownership and
  // idle facts after it, then fence input without another await.
  const inspection = inspectPair(ctx, id, version)
  if (!inspection.canRelease) throw new LiveSessionError(inspection.reason, `cannot safely release session ${JSON.stringify(id)}: ${inspection.reason}`)
  const { agent, session, fiber, dispose } = inspection
  if (releases.has(agent)) throw new LiveSessionError('release-in-progress', 'live session release is already in progress')
  releases.add(agent)

  let restoreFence
  let teardownStarted = false
  try {
    restoreFence = fenceInputs(agent)
    requireIdleAndEmpty(agent)
    await agent.whenIdle()
    requireIdleAndEmpty(agent)
    if (ctx.agents.get(id) !== agent || ctx.sessions.get(id) !== session) {
      throw new LiveSessionError('live-session-changed', 'live Agent or Session changed during workspace migration')
    }
    const matches = lifecycleDisposers(ctx, agent, id, version)
    if (matches === undefined || matches.length !== 1 || matches[0].fiber !== fiber || matches[0].dispose !== dispose) {
      throw new LiveSessionError('lifecycle-owner-changed', 'the exact Native lifecycle owner changed during workspace migration')
    }

    teardownStarted = true
    await Reflect.apply(dispose, fiber, [])

    if (ctx.agents.get(id) !== undefined || ctx.sessions.get(id) !== undefined) {
      throw new LiveSessionError('lifecycle-detach-incomplete', 'Native lifecycle teardown did not detach the selected Agent and Session')
    }
    const writer = await ctx.sessionPersistence.open(id, 'write')
    await writer.close()
    return { sessionId: id, released: true }
  } catch (error) {
    if (!teardownStarted && ctx.agents.get(id) === agent && ctx.sessions.get(id) === session) restoreFence?.()
    throw error
  } finally {
    releases.delete(agent)
  }
}

