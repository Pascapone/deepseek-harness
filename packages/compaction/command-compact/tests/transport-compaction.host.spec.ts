import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { createWebConnectionRpc } from '@deepseek-ai/dsh-client-connection/src/client/rpc.ts'
import { bridge } from '@deepseek-ai/dsh-client-connection/src/http-bridge.ts'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import Commands from '@deepseek-ai/dsh-commands'
import * as commandCompact from '@deepseek-ai/dsh-command-compact'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { SummaryResult, SummarizationInput } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import { createUserMessage, LlmAdapter, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it, vi } from 'vitest'

/** Only the external summarizer is delayed; transaction and maintenance stay real. */
class SlowSummarizer extends BasicCompactionEngine {
  delayMs = 90_000
  readonly signals: AbortSignal[] = []
  started = Promise.withResolvers<undefined>()

  override async summarize(_input: SummarizationInput, _agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
    if (signal === undefined) throw new Error('manual summary lost its cancellation signal')
    this.signals.push(signal)
    this.started.resolve(undefined)
    // Deliberately return late even after cancellation: the transaction must reject it.
    await new Promise<void>((resolve) => { setTimeout(resolve, this.delayMs) })
    return { summary: [{ type: 'text', text: 'checkpoint' }], provider: 'fake', model: 'fake' }
  }
}

class AnswerAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Socket boundary and compact operation correlation without credentials or prompt data. */
async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-compact-transport-'))
  const ctx = new Context()
  const server = createServer()
  const trace: {
    hop: string
    ms: number
    reason?: unknown
    rpcId?: string | undefined
    commandId?: string
    compactionId?: string
  }[] = []
  let rpcId: string | undefined
  let response: ServerResponse | undefined
  let engine: SlowSummarizer | undefined
  const bridges = new Set<Promise<void>>()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TypertRegistry)
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['loop', AgentLoop], ['meter', TokenMeter], ['commands', Commands],
      ['compact', commandCompact], ['gateway', Gateway],
      ['fake-summary', {
        inject: BasicCompactionEngine.inject,
        apply(owner: Context) { engine = new SlowSummarizer(owner, { auto: false }) },
      }],
      ['transport', {
        apply(owner: Context) {
          // Shared-handler tests bypass admission; browser authentication has separate coverage.
          new HostConnectionService(owner, [], {} as BrowserAuth)
        },
      }],
    ])
    const internal = ctx.loader.internal
    if (internal === undefined) throw new Error('transport composition requires the Node module loader')
    ctx.loader.internal = new Proxy(internal, {
      get(target, property) {
        if (property === 'import') return async (specifier: string) => {
          if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
          return modules.get(specifier)
        }
        const value: unknown = Reflect.get(target, property, target)
        const bound: unknown = typeof value === 'function' ? value.bind(target) : value
        return bound
      },
    })
    const config = join(root, 'cordis.yml')
    await writeFile(config, [...modules.keys()].map(name =>
      name === 'loop' ? '- name: loop\n  config: { agents: [] }' : `- name: ${name}`,
    ).join('\n') + '\n')
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    if (engine === undefined) throw new Error('Loader did not activate the real compaction engine')
    const compact = engine
    ctx.llm.registerAdapter(['fake'], new AnswerAdapter())
    let created: Agent | undefined
    const agentOwner = ctx.plugin({
      inject: ['agentLoop'],
      async apply(owner: Context) {
        created = await owner.agentLoop.create(SessionId('transport-compact'), { provider: 'fake', model: 'fake' })
      },
    })
    await agentOwner
    if (created === undefined) throw new Error('agent owner did not create the test agent')
    const agent = created
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'older history '.repeat(200) }], source: { kind: 'user' },
    }))
    await agent.whenIdle()
    ctx.on('session/event', (session, event) => {
      if (session === agent.session && /^(command|compaction)\//u.test(event.type)) {
        trace.push({
          hop: event.type, ms: performance.now(), rpcId,
          ...'commandId' in event.data ? { commandId: event.data.commandId } : {},
          ...'sourceCommandId' in event.data ? { commandId: event.data.sourceCommandId } : {},
          ...'compactionId' in event.data ? { compactionId: event.data.compactionId } : {},
        })
      }
    })
    const shared = ctx.connection.createSharedFetchHandler('/api')
    server.on('request', (req, res) => {
      response = res
      const pending = bridge(req, res, {
        requestBodyMode: request => shared.requestBodyMode(request),
        fetch: (request) => {
          trace.push({ hop: 'server-request', ms: performance.now(), rpcId })
          request.signal.addEventListener('abort', () => {
            trace.push({ hop: 'server-abort', ms: performance.now(), rpcId, reason: request.signal.reason })
          }, { once: true })
          return shared.fetch(request)
        },
      })
      bridges.add(pending)
      void pending.then(() => bridges.delete(pending), () => bridges.delete(pending))
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    const rpc = createWebConnectionRpc((input, init) => {
      if (typeof init.body !== 'string') throw new Error('browser RPC body must be JSON text')
      const envelope: unknown = JSON.parse(init.body)
      if (typeof envelope !== 'object' || envelope === null || !('rpcId' in envelope) || typeof envelope.rpcId !== 'string') {
        throw new Error('browser RPC lost its correlation id')
      }
      rpcId = envelope.rpcId
      trace.push({ hop: 'browser-request', ms: performance.now(), rpcId })
      init.signal?.addEventListener('abort', () => {
        trace.push({ hop: 'browser-abort', ms: performance.now(), rpcId, reason: init.signal?.reason })
      }, { once: true })
      return fetch(new URL(input, origin), init)
    })
    return {
      agent, compact, trace,
      disposeAgent: () => agentOwner.dispose(),
      agentRegistered: () => ctx.agents.get(agent.id) !== undefined,
      call: (signal?: AbortSignal) => rpc.call('/api', 'commands/execute', {
        args: { agentId: agent.id, line: '/compact', submittedAttachments: [] },
      }, signal),
      disconnect() {
        trace.push({ hop: 'test-socket-close', ms: performance.now() })
        response?.destroy()
      },
      async dispose() {
        await vi.runAllTimersAsync()
        await Promise.allSettled(bridges)
        await ctx.fiber.dispose()
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) resolve()
            else reject(error)
          })
        })
        await rm(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    server.closeAllConnections()
    server.close()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

const eventsOf = (agent: Agent, type: string) => agent.session.snapshotEvents().filter(event => event.type === type)

describe('manual compact unary HTTP lifetime', () => {
  it.each(['complete', 'socket-close', 'caller-abort', 'user-stop', 'disposed'] as const)(
    'keeps transaction ownership through a 90s fake summary: %s', async (outcome) => {
      const test = await harness()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
      try {
        const before = [...test.agent.session.surface.nodes]
        const caller = new AbortController()
        // Observe rejection immediately so a real socket failure cannot become unhandled.
        const pending = test.call(caller.signal).then(value => ({ value }), (error: unknown) => ({ error }))
        await Promise.race([
          test.compact.started.promise,
          pending.then((result) => { throw new Error(`command settled before summarization: ${JSON.stringify(result)}`) }),
        ])
        const signal = test.compact.signals[0]
        if (signal === undefined) throw new Error('summary did not start')
        const start = test.trace.find(item => item.hop === 'compaction/start')
        expect(typeof start?.rpcId).toBe('string')
        expect(typeof start?.commandId).toBe('string')
        expect(typeof start?.compactionId).toBe('string')
        expect(start?.rpcId).toBe(test.trace.find(item => item.hop === 'browser-request')?.rpcId)
        signal.addEventListener('abort', () => {
          test.trace.push({ ...start, hop: 'summary-abort', ms: performance.now(), reason: signal.reason })
        }, { once: true })
        await vi.advanceTimersByTimeAsync(60_000)
        expect(signal.aborted).toBe(false)
        expect(eventsOf(test.agent, 'command/done')).toHaveLength(0)
        expect(eventsOf(test.agent, 'compaction/summary')).toHaveLength(0)
        const callerReason = new Error('test explicit caller stop')
        const stopReason = { kind: 'user' } as const
        let disposal: Promise<void> | undefined
        if (outcome === 'socket-close') test.disconnect()
        if (outcome === 'caller-abort') caller.abort(callerReason)
        if (outcome === 'user-stop') test.agent.cancel(stopReason)
        if (outcome === 'disposed') disposal = test.disposeAgent()
        if (outcome === 'socket-close' || outcome === 'caller-abort') {
          await pending
          await vi.waitFor(() => { expect(signal.aborted).toBe(true) })
          const serverAbort = test.trace.find(item => item.hop === 'server-abort')
          expect(serverAbort?.reason).toBeInstanceOf(DOMException)
          expect(serverAbort?.reason).toMatchObject({ name: 'AbortError', message: 'This operation was aborted' })
          expect(signal.reason).toBe(serverAbort?.reason)
          expect(eventsOf(test.agent, 'command/done')).toHaveLength(1)
          expect(eventsOf(test.agent, 'command/done')[0]?.data).toMatchObject({
            kind: 'error', text: 'This operation was aborted',
          })
        }
        if (outcome === 'caller-abort') {
          const aborted = await pending
          expect('error' in aborted ? aborted.error : undefined).toBe(callerReason)
        }
        if (outcome === 'user-stop') expect(signal.reason).toBe(stopReason)
        if (outcome === 'disposed') {
          await vi.waitFor(() => { expect(signal.aborted).toBe(true) })
          expect(signal.reason).toEqual({ kind: 'disposed' })
        }
        // Early command settlement must NOT release maintenance while summary work remains.
        expect(() => test.agent.runMaintenance(async () => {})).toThrow(/active work/u)
        await vi.advanceTimersByTimeAsync(30_000)
        const result = await pending
        await test.agent.whenIdle()
        expect(eventsOf(test.agent, 'command/done')).toHaveLength(1)
        expect(eventsOf(test.agent, 'compaction/end')).toHaveLength(1)
        if (outcome === 'complete') {
          expect(result, JSON.stringify(eventsOf(test.agent, 'compaction/end'))).toMatchObject({ value: { ok: true, value: { result: { kind: 'success' } } } })
          expect(eventsOf(test.agent, 'compaction/summary')).toHaveLength(1)
          expect(test.agent.session.surface.nodes).not.toEqual(before)
        } else {
          expect(eventsOf(test.agent, 'compaction/summary')).toHaveLength(0)
          expect(test.agent.session.surface.nodes).toEqual(before)
          expect(eventsOf(test.agent, 'compaction/end')[0]?.data).toHaveProperty('error')
          if (outcome !== 'disposed') {
            test.compact.delayMs = 0
            const retry = test.call()
            await vi.waitFor(() => { expect(test.compact.signals).toHaveLength(2) })
            await vi.advanceTimersByTimeAsync(0)
            expect(await retry).toMatchObject({ ok: true, value: { result: { kind: 'success' } } })
          }
        }
        if (disposal !== undefined) {
          await disposal
          expect(test.agentRegistered()).toBe(false)
        } else {
          await expect(test.agent.runMaintenance(async () => 'released')).resolves.toBe('released')
        }
      } finally {
        await test.dispose()
        vi.useRealTimers()
      }
    },
  )
})
