/** Real Loader, settings, loop, compaction and JSONL acceptance; only model transport is synthetic. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage, LlmAdapter, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmReplayRequestPricing, LlmResolvedModelInfo, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompactionEngine from '../src/index.ts'
import RetentionSettings from '../src/retention-settings.ts'

const C = 20_000
const RESERVE = 4_000
const NATIVE_OUTPUT = 4_000
const scope = { version: 1, adapter: 'accounting-loader-fixture', projection: 'native-footprint-v1',
  provider: 'external-fixture', api: 'fixture-response', model: 'native-20k' } as const

/** The provider's protocol, independent of the meter's estimates or selection. */
function nativeFootprint(message: RequestMessage): number | undefined {
  if (message.role !== 'assistant') return undefined
  const state = message.source.replayState
  if (typeof state !== 'object' || state === null || !('response' in state)) return undefined
  const response = state.response
  if (typeof response !== 'object' || response === null
    || !('kind' in response) || response.kind !== 'fixture-native'
    || !('version' in response) || response.version !== 1
    || !('provider' in response) || response.provider !== scope.provider
    || !('api' in response) || response.api !== scope.api
    || !('model' in response) || response.model !== scope.model
    || !('nativeTokens' in response)) return undefined
  return typeof response.nativeTokens === 'number' ? response.nativeTokens : undefined
}

interface Bill { readonly input: number; readonly native: number; readonly reserve: number; readonly summary: boolean }
class IndependentProvider extends LlmAdapter {
  readonly bills: Bill[] = []
  private outputs = 0
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: C }, defaultMaxTokens: RESERVE })
  }
  override replayRequestPricing(): LlmReplayRequestPricing {
    return { scope, priceMessages: messages => messages.flatMap(message => message.role !== 'assistant' ? [] : [{
      messageId: message.id, replay: nativeFootprint(message) === undefined ? 'fallback' : 'native',
      basis: nativeFootprint(message) === undefined ? 'unknown' : 'usage-output',
    }]) }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // This is the fixture provider's independently declared tokenizer and schema charge.
    // It never asks the meter what fits or what bill to return.
    let native = 0
    let input = (options.tools?.length ?? 0) * 100
    for (const message of options.messages) {
      const retained = nativeFootprint(message)
      if (retained !== undefined) { native += retained; input += retained; continue }
      input += 8
      for (const block of message.content) {
        if (block.type === 'text' || block.type === 'reasoning') input += Math.ceil(Buffer.byteLength(block.text, 'utf8') / 4)
        else if (block.type === 'tool-call') input += Math.ceil(Buffer.byteLength(block.name + block.arguments, 'utf8') / 4)
        else throw new Error(`fixture provider does not implement ${block.type}`)
      }
    }
    const reserve = options.maxTokens ?? RESERVE
    const summary = options.purpose === 'compaction'
    this.bills.push({ input, native, reserve, summary })
    if (input + reserve > C) throw new LlmError(`fixture input ${input} plus response ${reserve} exceeds ${C}`, CONTEXT_WINDOW_EXCEEDED_CODE)
    if (!summary) this.outputs += 1
    const tool = !summary && this.outputs === 3
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: summary ? 'Checkpoint facts.' : 'ok done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: summary ? 'Checkpoint facts.' : 'ok done' } }
    if (tool) {
      const id = ToolCallId('retained-echo')
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      yield { type: 'block-end', index: 1, block: { type: 'tool-call', id, name: 'echo', arguments: '{"text":"retained pair"}' } }
    }
    const output = summary ? 16 : NATIVE_OUTPUT
    yield { type: 'usage', usage: { inputTokens: input, outputTokens: output, totalTokens: input + output,
      ...summary ? {} : { reasoningTokens: output - 2 } } }
    yield { type: 'finish', reason: { kind: tool ? 'tool-calls' : 'stop' },
      ...summary ? {} : { replayState: { response: { kind: 'fixture-native', version: 1,
        provider: scope.provider, api: scope.api, model: scope.model, nativeTokens: NATIVE_OUTPUT, opaque: 'synthetic' } } } }
  }
}

async function send(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  await agent.whenIdle()
}

it('releases native replay pressure through real Loader compaction, persisted retention, whole tool groups and cold replay', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'accounting-loader-')))
  let ctx: Context | undefined
  onTestFinished(async () => {
    await ctx?.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  const dir = join(home, 'profiles', 'acceptance')
  initProfile(dir, ['accounting-acceptance'])
  const bundle = join(dir, 'node_modules', 'accounting-acceptance')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"isolated-accounting-acceptance"}\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'accounting-acceptance', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'compaction-retention', name: 'cordis:retention' },
    { id: 'llm', name: 'cordis:llm' },
    { id: 'sessions', name: 'cordis:sessions' },
    { id: 'projections', name: 'cordis:projections' },
    { id: 'persistence', name: 'cordis:persistence', config: { root: join(home, 'sessions'), compression: 'none' } },
    { id: 'prompt', name: 'cordis:prompt', config: { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: 'Fixture acceptance.' } },
    { id: 'tools', name: 'cordis:tools' },
    { id: 'agents', name: 'cordis:agents' },
    { id: 'meter', name: 'cordis:meter' },
    { id: 'provider', name: 'cordis:provider' },
    { id: 'compaction', name: 'cordis:compaction', config: { auto: true, thresholdRatio: 0.9, headroomTokens: 1000, retainTokens: 100, maxTokens: RESERVE } },
    { id: 'loop', name: 'cordis:loop', config: { agents: [] } },
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = { name: 'acceptance', startedBundles: ['accounting-acceptance'], dir,
    patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined }
  const provider = new IndependentProvider()
  const toolExecutions: string[] = []
  const app = await boot('acceptance', join(dir, 'cordis.yml'), readProfilePatches('acceptance', profile), (root) => {
    ctx = root
    root.provide('profileContext', profile)
    Object.assign(root.loader.builtins, {
      editor: ConfigEditor, settings: Settings, retention: RetentionSettings, llm: LlmRuntime, sessions: SessionStore,
      projections: SessionProjectionRegistry, persistence: JsonlSessionPersistence, prompt: SystemPrompt,
      tools: ToolRuntime, agents: AgentRegistry, meter: TokenMeter, compaction: BasicCompactionEngine, loop: AgentLoop,
      provider: { inject: ['llm', 'tools'], apply(owner: Context) {
        owner.effect(() => owner.llm.registerAdapter(['acceptance'], provider))
        owner.effect(() => owner.tools.register(defineTool({
          name: 'echo', description: 'Return the supplied text.', parameters: { text: { type: 'string', required: true } },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          execute: async (args) => { toolExecutions.push(args.text); return args.text },
        })))
      } },
    })
  })
  expect([...app.loader.entries()].filter(entry => !entry.disabled && entry.fiber === undefined)).toEqual([])
  expect(app.compaction).toBeInstanceOf(BasicCompactionEngine)
  await app.settings.update('compaction-retention', { retention: { mode: 'tokens', value: 4000 } })
  const retentionEntry = app.configEditor.entries().find(entry => entry.options.id === 'compaction-retention')
  if (retentionEntry === undefined) throw new Error('retention was not loaded')
  await app.configEditor.edit(retentionEntry, raw => ({ ...raw, retention: { mode: 'tokens', value: 6000 } }))
  expect(app.compactionRetention.current()).toEqual({ retainTokens: 6000 })
  expect(await readFile(profile.patchPath, 'utf8')).toContain('6000')
  const errors: unknown[] = []
  app.on('agent/error', ({ error }) => { errors.push(error) })
  const agent = await app.agentLoop.create(SessionId('native-pressure-acceptance'), { provider: 'acceptance', model: 'native-20k', maxTokens: RESERVE }, { cwd: home })
  await send(agent, 'first')
  await send(agent, 'second')
  await send(agent, 'third')
  expect(errors).toEqual([])
  expect(provider.bills.filter(bill => !bill.summary)).toHaveLength(4)
  expect(provider.bills.filter(bill => bill.summary)).toHaveLength(0)
  expect(app.tokenMeter.measure(agent.session).inputTokens).toBeGreaterThan(15_000)
  expect(toolExecutions).toEqual(['retained pair'])
  await send(agent, 'after pressure')
  expect(errors).toEqual([])
  const summaryCalls = provider.bills.filter(bill => bill.summary)
  expect(summaryCalls).toHaveLength(1)
  const after = provider.bills.filter(bill => !bill.summary).at(-1)
  expect(after?.native).toBe(8000)
  expect(after?.input).toBeLessThan(C - RESERVE)
  expect(provider.bills.every(bill => bill.input + bill.reserve <= C)).toBe(true)
  const retained = agent.session.deriveMessages()
  expect(retained.some(message => message.role === 'assistant' && message.content.some(block => block.type === 'tool-call' && block.id === 'retained-echo'))).toBe(true)
  expect(retained.some(message => message.role === 'tool' && message.toolCallId === 'retained-echo')).toBe(true)
  expect(agent.session.snapshotEvents().filter(event => event.type === 'compaction/start')).toHaveLength(1)
  expect(agent.session.requestContext()?.retention).toEqual({ retainTokens: 6000, source: 'settings' })
  const forecast = app.tokenMeter.measure(agent.session)
  expect(app.sessionProjections.snapshot(agent.session).values.contextPressure?.projectedTokens).toBe(forecast.inputTokens)
  const breakdown = app.sessionProjections.snapshot(agent.session).values.contextBreakdown
  expect((breakdown?.systemTokens ?? 0) + (breakdown?.toolsTokens ?? 0)
    + (breakdown?.messageTokens ?? 0) + (breakdown?.unattributedTokens ?? 0)).toBe(forecast.inputTokens)
  await send(agent, 'one more safe turn')
  expect(errors).toEqual([])
  expect(provider.bills.filter(bill => bill.summary)).toHaveLength(1)
  await app.sessions.flush(agent.session)
  const handle = await app.sessionPersistence.open(agent.session.id, 'read')
  let stored: Awaited<ReturnType<typeof handle.read>>
  try { stored = await handle.read() } finally { await handle.close() }
  const cold = Session.create(SessionId('cold-price-acceptance'), stored.events)
  const providerEntry = [...app.loader.entries()].find(entry => entry.options.id === 'provider')
  if (providerEntry?.fiber === undefined) throw new Error('provider was not loaded')
  await providerEntry.fiber.dispose()
  expect(app.llm.replayRequestPricing('acceptance', 'native-20k')).toBeUndefined()
  expect(app.tokenMeter.measure(cold).inputTokens).toBe(app.tokenMeter.measure(agent.session).inputTokens)
  const fork = app.sessions.fork(agent.session, undefined, SessionId('fork-price-acceptance'))
  expect(app.tokenMeter.measure(fork).inputTokens).toBe(app.tokenMeter.measure(agent.session).inputTokens)
  expect(app.sessionProjections.snapshot(cold).values.contextPressure)
    .toEqual(app.sessionProjections.snapshot(agent.session).values.contextPressure)
})
