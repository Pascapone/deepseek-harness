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
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '../src/index.ts'
import * as Spawn from '../../subagent-spawn-in-process/src/index.ts'
import * as Fork from '../../subagent-fork-in-process/src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import { continuationManager } from './continuation-internals.ts'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../subagent-in-process-driver/tests/fixtures')
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

it('binds a different native preset before the first child request and retains it on resume', async () => {
  const ctx = new Context()
  const root = mkdtempSync(join(tmpdir(), 'dsh-selected-preset-'))
  cleanups.push(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  ctx.baseUrl = pathToFileURL(fixtures).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await liveConfig(ctx, Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(Fork, { providerName: 'fork' })
  await ctx.plugin(AgentPresets, { default: 'coding' })
  for (const [id, tool] of [['coding', 'coding_only'], ['reviewing', 'reviewing_only']] as const) {
    await ctx.agentPresets.register({ id, plugins: [tool, ...(id === 'reviewing' ? ['privileged'] : [])]
      .map(name => ({ name: pathToFileURL(join(fixtures, 'plugins/preset-tool.js')).href, config: { tool: name } })) })
  }
  const adapter = new MockAdapter([textResponse('review done'), textResponse('parent acknowledged'),
    textResponse('review followup'), textResponse('parent acknowledged again'),
    textResponse('fork first'), textResponse('parent after fork'),
    textResponse('fork resumed'), textResponse('parent after fork resume')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const observed: Array<{ id: string; preset?: string; tools: string[] }> = []
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.origin === 'subagent') observed.push({ id: agent.id,
      ...(agent.session.header.agentPreset === undefined ? {} : { preset: agent.session.header.agentPreset }),
      tools: ctx.tools.schemas(agent).map(tool => tool.name) })
  })
  const parentHandle = await ctx.agents.create({ sessionId: SessionId('parent'),
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'coding') })
  const parent = parentHandle.agent
  const selection = (provider: string, agentPreset: string) => ({ provider, label: 'review',
    request: { parent, prompt: [{ type: 'text' as const, text: 'Review this' }], agentPreset,
      agentOptions: { provider: 'mock', model: 'mock' } }, signal: new AbortController().signal })
  await expect(ctx.subagents.startContinuable(selection('fork', 'reviewing')))
    .rejects.toMatchObject({ code: 'UNSUPPORTED_PRESET' })
  await expect(ctx.subagents.startContinuable(selection('spawn', 'missing')))
    .rejects.toMatchObject({ code: 'PRESET_UNAVAILABLE' })
  expect(observed).toHaveLength(0)
  const started = await ctx.subagents.startContinuable({ provider: 'spawn', label: 'review',
    request: { parent, prompt: [{ type: 'text', text: 'Review this' }], agentPreset: 'reviewing',
      toolFilter: { deny: ['privileged'] },
      agentOptions: { provider: 'mock', model: 'mock' } }, signal: new AbortController().signal })
  expect(observed[0]).toEqual({ id: started.childId, preset: 'reviewing', tools: ['reviewing_only'] })
  await vi.waitFor(() => expect(ctx.agents.get(started.childId)).toBeUndefined())
  expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['reviewing_only'])
  await ctx.agentPresets.recompose(parent.ctx, 'coding')
  await continuationManager(ctx).queuePrompt(parent, started.childId, [{ type: 'text', text: 'Follow up' }], { kind: 'user' }, new AbortController().signal)
  expect(observed[1]).toEqual({ id: started.childId, preset: 'reviewing', tools: ['reviewing_only'] })
  await vi.waitFor(() => expect(ctx.agents.get(started.childId)).toBeUndefined())
  expect(adapter.requests.slice(0, 4).map(request => request.tools?.map(tool => tool.name)))
    .toEqual([['reviewing_only'], ['coding_only'], ['reviewing_only'], ['coding_only']])
  const fork = await ctx.subagents.startContinuable({ provider: 'fork', label: 'native fork',
    request: { parent, prompt: [{ type: 'text', text: 'Continue here' }],
      agentOptions: { provider: 'mock', model: 'mock' } }, signal: new AbortController().signal })
  await vi.waitFor(() => expect(ctx.agents.get(fork.childId)).toBeUndefined())
  expect(observed[2]?.tools).toEqual(['coding_only'])
  await ctx.agentPresets.recompose(parent.ctx, 'reviewing')
  await continuationManager(ctx).queuePrompt(parent, fork.childId, [{ type: 'text', text: 'Same fork again' }],
    { kind: 'user' }, new AbortController().signal)
  expect(observed[3]?.tools, 'native seeded fork keeps following its live parent').toEqual(['reviewing_only', 'privileged'])
})
