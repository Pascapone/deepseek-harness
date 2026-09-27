import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { HarnessError, ToolCallId } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '../src/index.ts'
import * as Spawn from '../../subagent-spawn-in-process/src/index.ts'
import * as Fork from '../../subagent-fork-in-process/src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../subagent-in-process-driver/tests/fixtures')
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

it.skipIf(!process.env.DSH_MULTI_AGENT_V2_BUNDLE)('V2 replaces only fresh-start and starts a preset-bound native child', async () => {
  const ctx = new Context()
  const root = mkdtempSync(join(tmpdir(), 'dsh-v2-plugin-'))
  cleanups.push(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  ctx.baseUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..')).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await liveConfig(ctx, Subagents)
  await liveConfig(ctx, AgentDefaultModel, { provider: 'mock', model: 'mock' })
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(Fork, { providerName: 'fork' })
  await ctx.plugin(AgentPresets, { default: 'coding' })
  // Built plugin dynamic imports must share Vitest's source-module scope registry.
  const nativeImport = ctx.loader.import.bind(ctx.loader)
  vi.spyOn(ctx.loader, 'import').mockImplementation(spec => spec === '@deepseek-ai/dsh-scope'
    ? Promise.resolve({ createScope, scopeOf }) : spec === '@deepseek-ai/dsh-llm'
      ? Promise.resolve({ HarnessError }) : nativeImport(spec))
  let releaseNative: (() => Promise<void>) | undefined
  for (const [id, tool] of [['coding', 'coding_only'], ['reviewing', 'reviewing_only'],
    ['locked', 'locked_only'], ['skill-limited', 'skill_limited_only'], ['native', 'native_only'], ['late', 'late_only']] as const) {
    const release = await ctx.agentPresets.register({ id, plugins: [
      ...(id === 'late' ? ['subagent_fork', tool] : ['subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', tool]).map(name =>
        ({ name: pathToFileURL(join(fixtures, 'plugins/preset-tool.js')).href, config: { tool: name } })),
      ...(id === 'native' ? [
        { name: '@local/dsh-multi-agent/v2', disabled: true },
        { name: pathToFileURL(join(dirname(process.env.DSH_MULTI_AGENT_V2_BUNDLE!), 'v2-native.js')).href,
          isolate: { multiAgentV2Native: true as const } },
      ] : []),
      ...(id === 'reviewing' ? [
        { name: pathToFileURL(join(fixtures, 'plugins/preset-tool.js')).href, config: { tool: 'privileged' } },
        { name: pathToFileURL(join(fixtures, 'plugins/model-default.js')).href,
          config: { provider: 'mock', model: 'review-special' } },
        { name: pathToFileURL(join(fixtures, 'plugins/preset-persona.js')).href, config: {} },
      ] : [{ name: pathToFileURL(join(dirname(process.env.DSH_MULTI_AGENT_V2_BUNDLE!), 'policy.js')).href,
        config: id === 'skill-limited' ? { skills: { secret: 'disabled' } }
          : { toolDeny: id === 'late' ? [] : [id === 'coding' ? 'privileged' : 'delegate_agent'] } }]),
    ] })
    if (id === 'native') releaseNative = release
  }
  const adapter = new MockAdapter([textResponse('old child done'), textResponse('parent before V2'),
    textResponse('child done'), textResponse('parent done'),
    textResponse('fork done'), textResponse('parent after fork'),
    textResponse('filtered child done'), textResponse('parent after filtered child')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const parentHandle = await ctx.agents.create({ sessionId: SessionId('parent'),
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'coding') })
  const parent = parentHandle.agent
  expect(ctx.tools.schemas(parent).map(tool => tool.name)).toContain('subagent')
  const oldChild = await ctx.subagents.startContinuable({ provider: 'spawn', label: 'before activation',
    request: { parent, prompt: [{ type: 'text', text: 'Old work' }],
      agentOptions: { provider: 'mock', model: 'mock' } }, signal: new AbortController().signal })
  await vi.waitFor(() => expect(ctx.agents.get(oldChild.childId)).toBeUndefined())
  await vi.waitFor(() => expect(parent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(true))
  await parent.whenIdle()
  const v2 = await import(pathToFileURL(process.env.DSH_MULTI_AGENT_V2_BUNDLE!).href)
  const warnings = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
  const v2Fiber = await ctx.plugin(v2)
  const tools = ctx.tools.schemas(parent).map(tool => tool.name)
  expect(tools, `${tools.join(', ')}; ${JSON.stringify(warnings.mock.calls)}`).toContain('delegate_agent')
  for (const native of ['subagent_fork', 'send_message', 'interrupt_agent', 'list_agents'])
    expect(tools).toContain(native)
  expect(tools).not.toContain('subagent')
  expect(ctx.tools.get('subagent', parent)).toBeUndefined()
  const nativeParent = (await ctx.agents.create({ sessionId: SessionId('native-parent'),
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'native') })).agent
  const nativeTools = ctx.tools.schemas(nativeParent).map(tool => tool.name)
  expect(nativeTools).toContain('subagent')
  expect(nativeTools).toContain('subagent_fork')
  for (const v2Tool of ['delegate_agent', 'list_agent_profiles', 'observe_agents', 'wait_agents', 'read_agent_detail'])
    expect(nativeTools).not.toContain(v2Tool)
  const lateParent = (await ctx.agents.create({ sessionId: SessionId('late-parent'),
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'late') })).agent
  expect(ctx.tools.get('observe_agents', lateParent)).toBeDefined()
  expect(ctx.tools.get('delegate_agent', lateParent)).toBeUndefined()
  lateParent.ctx.tools.register({ name: 'subagent', description: 'late native delegation',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: async () => 'late native delegation' })
  expect(ctx.tools.get('subagent', lateParent)).toBeUndefined()
  expect(ctx.tools.get('delegate_agent', lateParent)).toBeDefined()
  expect(ctx.tools.get('observe_agents', lateParent)).toBeDefined()
  const earlier = await ctx.tools.get('wait_agents', parent)!.execute(
    { agent_ids: [oldChild.childId], work_refs: { [oldChild.childId]: oldChild.messageId }, timeout_ms: 5000 },
    { agent: parent, signal: new AbortController().signal } as never) as { agents: Array<{ state: string }> }
  expect(earlier.agents[0]?.state).toBe('terminal')
  const blocked = await ctx.tools.execute({ agent: parent, callId: ToolCallId('blocked'),
    name: 'subagent', arguments: {}, signal: new AbortController().signal })
  expect(blocked.isError).toBe(true)
  if (blocked.isError) expect(blocked.error.message).toMatch(/subagent|delegate|unknown/i)
  const invalid = await ctx.tools.execute({ agent: parent, callId: ToolCallId('invalid'),
    name: 'list_agent_profiles', arguments: { cursor: 'bad' }, signal: new AbortController().signal })
  expect(invalid.isError && invalid.error.info?.code).toBe('CURSOR_INVALID')
  const result = await ctx.tools.get('delegate_agent', parent)!.execute(
    { preset_id: 'reviewing', description: 'Review', prompt: 'Review files.' },
    { agent: parent, signal: new AbortController().signal } as never) as {
    agent_id: SessionId
    preset_id: string
    work_ref: string
    model: { model: string }
  }
  expect(result.preset_id).toBe('reviewing')
  expect(result.model.model).toBe('review-special')
  const waited = await ctx.tools.get('wait_agents', parent)!.execute(
    { agent_ids: [result.agent_id], work_refs: { [result.agent_id]: result.work_ref }, timeout_ms: 5000 },
    { agent: parent, signal: new AbortController().signal } as never) as {
    outcome: string
    agents: Array<{ state: string; result_ref?: { event_seq: number } }>
  }
  expect(waited).toMatchObject({ outcome: 'terminal', agents: [{ state: 'terminal' }] })
  const detail = await ctx.tools.get('read_agent_detail', parent)!.execute(
    { agent_id: result.agent_id, event_seq: waited.agents[0]!.result_ref!.event_seq, field: 'text' },
    { agent: parent, signal: new AbortController().signal } as never) as { chunk: string }
  expect(detail.chunk).toContain('child done')
  await vi.waitFor(() => expect(ctx.agents.get(result.agent_id)).toBeUndefined())
  await vi.waitFor(() => expect(parent.session.snapshotEvents().filter(event => event.type === 'turn/start').length).toBe(2))
  await parent.whenIdle()
  const updates = await ctx.tools.get('observe_agents', parent)!.execute(
    { agent_ids: [oldChild.childId, result.agent_id] },
    { agent: parent, callId: 'v2-observation', signal: new AbortController().signal } as never) as { results: Array<{ ok: boolean; messages: Array<{ preview: string }> }>; next_cursor: string }
  expect(updates.results[0]?.ok).toBe(true)
  expect(updates.results[0]?.messages.some(message => message.preview.includes('old child done'))).toBe(true)
  expect(updates.results[1]?.messages.some(message => message.preview.includes('child done'))).toBe(true)
  expect(updates.next_cursor).toBeTruthy()
  const fork = await ctx.subagents.startContinuable({ provider: 'fork', label: 'same context',
    request: { parent, prompt: [{ type: 'text', text: 'Follow up in context' }],
      agentOptions: { provider: 'mock', model: 'mock' } }, signal: new AbortController().signal })
  const forkWait = await ctx.tools.get('wait_agents', parent)!.execute(
    { agent_ids: [fork.childId], work_refs: { [fork.childId]: fork.messageId }, timeout_ms: 5000 },
    { agent: parent, signal: new AbortController().signal } as never) as { agents: Array<{ state: string }> }
  expect(forkWait.agents[0]?.state).toBe('terminal')
  await vi.waitFor(() => expect(ctx.agents.get(fork.childId)).toBeUndefined())
  await vi.waitFor(() => expect(parent.session.snapshotEvents().filter(event => event.type === 'turn/start').length).toBe(3))
  await parent.whenIdle()
  const forkUpdates = await ctx.tools.get('observe_agents', parent)!.execute(
    { agent_ids: [fork.childId] },
    { agent: parent, callId: 'v2-fork-observation', signal: new AbortController().signal } as never) as { results: Array<{ ok: boolean }> }
  expect(forkUpdates.results[0]?.ok).toBe(true)
  expect(JSON.stringify(forkUpdates)).not.toContain('parent done')
  await expect(ctx.tools.get('read_agent_detail', parent)!.execute(
    { agent_id: fork.childId, event_seq: 0, field: 'text' },
    { agent: parent, signal: new AbortController().signal } as never))
    .rejects.toMatchObject({ code: 'DETAIL_UNAVAILABLE' })
  const filtered = await ctx.subagents.startContinuable({ provider: 'spawn', label: 'allowlisted child',
    request: { parent, prompt: [{ type: 'text', text: 'Use only allowed tools' }],
      toolFilter: { allow: ['coding_only', 'subagent_fork'] },
      agentOptions: { provider: 'mock', model: 'mock' } }, signal: new AbortController().signal })
  await vi.waitFor(() => expect(ctx.agents.get(filtered.childId)).toBeUndefined())
  const allowedTools = adapter.requests[6]?.tools?.map(tool => tool.name)
  expect(allowedTools).toContain('coding_only')
  expect(allowedTools).toContain('subagent_fork')
  for (const blockedName of ['subagent', 'delegate_agent', 'observe_agents', 'wait_agents', 'read_agent_detail'])
    expect(allowedTools).not.toContain(blockedName)
  expect(adapter.requests[2]?.model).toBe('review-special')
  expect(adapter.requests[2]?.tools?.map(tool => tool.name)).toContain('reviewing_only')
  expect(adapter.requests[2]?.tools?.map(tool => tool.name)).not.toContain('privileged')
  expect(adapter.requests[2]?.tools?.map(tool => tool.name)).not.toContain('subagent')
  expect(adapter.requests[4]?.tools?.map(tool => tool.name)).toContain('coding_only')
  const prompt = JSON.stringify(adapter.requests[2])
  expect((prompt.match(/Multi-agent workflow:/g) ?? []).length).toBe(1)
  expect(prompt).toContain('delegate_agent')
  expect(prompt).toContain('subagent_fork')
  expect(prompt).toContain('REVIEW_SPECIALIST_PERSONA')
  expect(JSON.stringify(adapter.requests[3])).not.toContain('REVIEW_SPECIALIST_PERSONA')
  expect(prompt).toContain('send_message')
  const stale = ctx.tools.get('delegate_agent', parent)!.execute
  const lockedParent = (await ctx.agents.create({ sessionId: SessionId('locked-parent'),
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'locked') })).agent
  const lockedDenies = new Set<string>()
  ;(ctx.emit as unknown as (name: string, agent: typeof lockedParent, out: Set<string>) => void)(
    'dsh-multi-agent/tool-denies', lockedParent, lockedDenies)
  expect([...lockedDenies]).toContain('delegate_agent')
  const locked = ctx.tools.schemas(lockedParent).map(tool => tool.name)
  expect(locked).not.toContain('delegate_agent')
  expect(locked).not.toContain('list_agent_profiles')
  expect(locked).not.toContain('subagent')
  expect(locked).toContain('subagent_fork')
  const denied = await ctx.tools.execute({ agent: lockedParent, callId: ToolCallId('denied-delegate'),
    name: 'delegate_agent', arguments: { preset_id: 'reviewing', description: 'Denied', prompt: 'No.' },
    signal: new AbortController().signal })
  expect(denied.isError).toBe(true)
  const skillParent = (await ctx.agents.create({ sessionId: SessionId('skill-parent'),
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'skill-limited') })).agent
  expect(ctx.tools.get('delegate_agent', skillParent)).toBeDefined()
  await expect(ctx.tools.get('delegate_agent', skillParent)!.execute(
    { preset_id: 'reviewing', description: 'Cross-profile', prompt: 'Should reject.' },
    { agent: skillParent, signal: new AbortController().signal } as never))
    .rejects.toMatchObject({ code: 'FORBIDDEN' })
  await v2Fiber.dispose()
  const restored = ctx.tools.schemas(parent).map(tool => tool.name)
  expect(restored).toContain('subagent')
  expect(restored).toContain('subagent_fork')
  expect(restored).not.toContain('delegate_agent')
  expect(restored).not.toContain('observe_agents')
  await expect(Promise.resolve().then(() => stale(
    { preset_id: 'reviewing', description: 'Too late', prompt: 'Do not start.' },
    { agent: parent, signal: new AbortController().signal } as never))).rejects.toThrow()
  await releaseNative!()
  await ctx.agentPresets.register({ id: 'native', plugins: ['subagent', 'subagent_fork'].map(tool =>
    ({ name: pathToFileURL(join(fixtures, 'plugins/preset-tool.js')).href, config: { tool } })) })
  const restarted = await ctx.plugin(v2)
  expect(ctx.tools.get('subagent', nativeParent)).toBeDefined() // old revision keeps its opt-out
  expect(ctx.tools.get('delegate_agent', nativeParent)).toBeUndefined()
  const newNative = (await ctx.agents.create({ sessionId: SessionId('new-native-parent'),
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'native') })).agent
  expect(ctx.tools.get('subagent', newNative)).toBeUndefined()
  expect(ctx.tools.get('delegate_agent', newNative)).toBeDefined()
  await restarted.dispose()
})
