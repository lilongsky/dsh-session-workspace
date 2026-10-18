import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { moveSessionWorkspace } from '../src/migration.js'

const nativeRoot = process.env.DSH_NATIVE_ROOT
const native = { skip: !nativeRoot && 'set DSH_NATIVE_ROOT for Native working-directory replay tests' }
const nativeImport = name => import(pathToFileURL(join(nativeRoot, 'node_modules/@deepseek-ai', name, 'lib/index.js')))

async function contextFor(root, compression) {
  const { Context } = await nativeImport('cordis')
  const ctx = new Context()
  try {
    for (const [name, config] of [
      ['dsh-storage'],
      ['dsh-storage-json', { root: join(root, 'storages') }],
      ['dsh-storage-domain', { backend: 'json' }],
      ['dsh-session-projection'],
      ['dsh-session'],
      ['dsh-session-persistence-jsonl', { root: join(root, 'sessions'), compression }],
      ['dsh-agent'],
      ['dsh-llm'],
      ['dsh-system-prompt'],
      ['dsh-tools'],
      ['dsh-agent-loop', { agents: [] }],
      ['dsh-fs-local', { cwd: root }],
      ['dsh-working-directory'],
      ['dsh-subprocess-local'],
      ['dsh-bash-local'],
      ['dsh-shell-env'],
      ['dsh-tool-bash'],
    ]) {
      const plugin = await nativeImport(name)
      await ctx.plugin(plugin.default ?? plugin, config).await()
    }
    return ctx
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

async function seed(ctx, id, cwd, selectedDirectory) {
  const { Session, SESSION_FORMAT_VERSION } = await nativeImport('dsh-session')
  const session = Session.create(id, [], {
    id, cwd, version: SESSION_FORMAT_VERSION, createdAt: 42, isSeeded: false, delegationDepth: 0,
  })
  session.append('user/message', {
    id: `${id}-user`, role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'retain complete pre-move history 🧪' }],
  }, { surfaceOp: 'append' })
  session.append('working-directory/change', { cwd: selectedDirectory })
  const events = session.snapshotEvents()
  const writer = await ctx.sessionPersistence.create(session.header)
  try {
    for (const event of events) await writer.append([event])
  } finally { await writer.close() }
  return { header: session.header, events }
}

async function startRegistry(ctx) {
  const plugin = await nativeImport('dsh-workspace')
  await ctx.plugin(plugin.default ?? plugin).await()
  return ctx.workspaceRegistry
}

function decode(bytes, path) {
  if (!path.endsWith('.zstd')) return { text: bytes.toString('utf8'), frames: 0 }
  const frames = []
  let offset = 0
  while (offset < bytes.length) {
    const frame = zstdDecompressSync(bytes.subarray(offset), { info: true })
    const consumed = frame.engine.bytesWritten
    assert.ok(consumed > 0 && consumed <= bytes.length - offset)
    frames.push(frame.buffer)
    offset += consumed
  }
  return { text: Buffer.concat(frames).toString('utf8'), frames: frames.length }
}

const body = text => text.slice(text.indexOf('\n') + 1)

async function snapshot(ctx, id) {
  const reader = await ctx.sessionPersistence.open(id, 'read')
  try { return { header: reader.header, ...(await reader.read()) } }
  finally { await reader.close() }
}

function coldContext(ctx) {
  return {
    sessionPersistence: ctx.sessionPersistence,
    workspaceRegistry: ctx.workspaceRegistry,
    agents: { get: () => undefined }, sessions: { get: () => undefined },
  }
}

for (const compression of ['none', 'zstd']) {
  test(`Native ${compression} move appends the selected directory and reopens into it for a real bash call`, native, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), `dsh-workspace-directory-${compression}-`)))
    const sourcePath = join(root, 'source'), targetPath = join(root, 'target'), customPath = join(root, 'previous-directory')
    await Promise.all([sourcePath, targetPath, customPath].map(path => mkdir(path)))
    let ctx, handle
    try {
      ctx = await contextFor(root, compression)
      const id = `directory-replay-${compression}`
      const expected = await seed(ctx, id, sourcePath, customPath)
      const control = await seed(ctx, `directory-control-${compression}`, sourcePath, sourcePath)
      const registry = await startRegistry(ctx)
      const source = registry.list().find(workspace => workspace.path === sourcePath)
      const target = await registry.create(targetPath, 'Directory target')
      const sourceArtifact = ctx.sessionPersistence.locate(expected.header).path
      const controlArtifact = ctx.sessionPersistence.locate(control.header).path
      const originalBytes = await readFile(sourceArtifact)
      const controlBytes = await readFile(controlArtifact)
      const original = decode(originalBytes, sourceArtifact)
      if (compression === 'zstd') assert.ok(original.frames >= 3, 'seed must contain multiple Native zstd frames')
      await rm(customPath, { recursive: true })
      const moved = await moveSessionWorkspace(coldContext(ctx), { sessionId: id, workspaceId: target.id })
      assert.equal(moved.sessionId, id)
      assert.deepEqual(await readFile(moved.backupPath), originalBytes)
      const movedArtifact = ctx.sessionPersistence.locate({ ...expected.header, cwd: targetPath }).path
      const movedText = decode(await readFile(movedArtifact), movedArtifact).text
      assert.ok(body(movedText).startsWith(body(original.text)), 'every old decoded body byte must remain an exact prefix')
      const migrated = await snapshot(ctx, id)
      assert.deepEqual(migrated.events.slice(0, expected.events.length), expected.events)
      assert.equal(migrated.events.length, expected.events.length + 1)
      assert.deepEqual(migrated.events.at(-1).data, { cwd: targetPath })
      assert.equal(migrated.events.at(-1).type, 'working-directory/change')
      assert.equal(migrated.events.at(-1).seq, expected.events.length)
      assert.deepEqual(await readFile(controlArtifact), controlBytes)
      assert.deepEqual(source.sessionIds, [control.header.id])
      assert.deepEqual(target.sessionIds, [id])

      await ctx.fiber.dispose()
      ctx = await contextFor(root, compression)
      const reopenedRegistry = await startRegistry(ctx)
      assert.deepEqual(reopenedRegistry.get(target.id).sessionIds, [id])
      handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'fixture', model: 'fixture' } })
      assert.equal(handle.agent.id, id)
      assert.equal(ctx.workingDirectory.get(handle.agent.session), targetPath)
      assert.deepEqual(handle.agent.session.snapshotEvents().slice(0, migrated.events.length), migrated.events)
      const result = await ctx.tools.execute({
        callId: `workspace-directory-pwd-${compression}`, name: 'bash',
        arguments: { description: 'Check the migrated working directory', command: 'pwd -P' },
        agent: handle.agent, signal: new AbortController().signal,
      })
      assert.notEqual(result.isError, true, JSON.stringify(result))
      const output = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      assert.ok(output.includes(targetPath.replace(/^\/var\//, '/private/var/')), output)
      assert.deepEqual(await readFile(controlArtifact), controlBytes)
    } finally {
      await handle?.dispose()
      await ctx?.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  test(`Native ${compression} directory reset rolls back exact original bytes when workspace attachment fails`, native, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), `dsh-workspace-directory-rollback-${compression}-`)))
    const sourcePath = join(root, 'source'), targetPath = join(root, 'target')
    await Promise.all([sourcePath, targetPath].map(path => mkdir(path)))
    let ctx
    try {
      ctx = await contextFor(root, compression)
      const id = `directory-rollback-${compression}`
      const expected = await seed(ctx, id, sourcePath, sourcePath)
      const registry = await startRegistry(ctx)
      const source = registry.list().find(workspace => workspace.path === sourcePath)
      const target = await registry.create(targetPath, 'Rollback target')
      const artifact = ctx.sessionPersistence.locate(expected.header).path
      const originalBytes = await readFile(artifact)
      target.attachSession = async () => { throw new Error('directory rollback test attachment failure') }
      await assert.rejects(moveSessionWorkspace(coldContext(ctx), { sessionId: id, workspaceId: target.id }), /directory rollback test attachment failure/)
      assert.deepEqual(await readFile(artifact), originalBytes)
      assert.deepEqual((await snapshot(ctx, id)).events, expected.events)
      assert.deepEqual(source.sessionIds, [id])
      assert.deepEqual(target.sessionIds, [])
    } finally {
      await ctx?.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
}
