import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CordisInspectRegistryService } from '../src/inspect-registry.ts'
import type { InspectConfig } from '../src/inspect-registry.ts'
import { DynamicCordisRunnerService } from '../src/index.ts'
import type { CordisInspectProviderManifest, CordisInspectQueryRequest, CordisInspectQueryResolution } from '../src/types.ts'

const agent = { id: 'inspect-owner' as SessionId } as Agent
const otherAgent = { id: 'inspect-other' as SessionId } as Agent
const provider: CordisInspectProviderManifest = {
  id: 'Service', description: 'Test service catalog',
  methods: [{ name: 'listService', description: 'Find a service', inputSchema: {}, outputSchema: { type: 'object' } }],
}
const failure = { ok: false, reason: 'provider-error', message: 'no catalogued Service named "sidebarRight"' } as const
let fiber: Fiber

async function setup(config: InspectConfig = {}) {
  const ctx = new Context()
  const mounted = ctx.plugin(CordisInspectRegistryService, config)
  fiber = mounted
  await mounted
  const registry = ctx.cordisInspect
  registry.syncClientManifest([provider])
  const requests: CordisInspectQueryRequest[] = []
  const closed = vi.fn()
  ctx.on('cordis/inspect-query', (request) => { requests.push(request) })
  ctx.on('cordis/inspect-query-resolved', closed)
  const abort = new AbortController()
  const query = () => registry.query('client', 'Service', 'listService', undefined, agent, abort.signal)
  const answer = (resolution: CordisInspectQueryResolution, owner = agent, index = 0) =>
    registry.resolveClientQuery(owner, requests[index]!.requestId, resolution)
  return { ctx, registry, requests, closed, abort, query, answer }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(async () => {
  await fiber?.dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('bounded Client inspect queries', () => {
  it('returns the first provider error after a non-resetting grace and ignores late replies', async () => {
    const h = await setup()
    const remove = vi.spyOn(h.abort.signal, 'removeEventListener')
    const result = h.query()
    const rejected = expect(result).rejects.toThrow('Service.listService: no catalogued Service named "sidebarRight"')
    expect(h.answer(failure)).toEqual({ accepted: false })
    await vi.advanceTimersByTimeAsync(249)
    expect(h.closed).not.toHaveBeenCalled()
    h.answer({ ok: false, reason: 'provider-missing', message: 'another page has no provider' })
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(h.closed).toHaveBeenCalledExactlyOnceWith({ requestId: h.requests[0]!.requestId })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(h.answer({ ok: true, data: {} })).toEqual({ accepted: false })
    expect(h.answer(failure)).toEqual({ accepted: false })
    h.abort.abort()
    expect(h.closed).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['provider-missing', 'method-missing', 'invalid-input', 'cancelled'] as const)(
    'surfaces %s instead of waiting forever', async (reason) => {
      const h = await setup()
      const result = h.query()
      const rejected = expect(result).rejects.toThrow(`Service.listService: ${reason}`)
      h.answer({ ok: false, reason, message: reason })
      await vi.advanceTimersByTimeAsync(250)
      await rejected
      expect(h.closed).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('times out silent pages at the hard deadline and cleans up', async () => {
    const h = await setup()
    const result = h.query()
    const rejected = expect(result).rejects.toThrow('Service.listService: Client inspect query timed out after 30000ms; no valid page response.')
    await vi.advanceTimersByTimeAsync(29_999)
    expect(h.closed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(h.answer({ ok: true, data: {} })).toEqual({ accepted: false })
    expect(h.closed).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([42, Number.NaN])('reports invalid output (%s) after grace', async (data) => {
    const h = await setup()
    const result = h.query()
    const rejected = expect(result).rejects.toThrow(data === 42 ? 'returned invalid output' : 'returned a non-JSON value')
    expect(h.answer({ ok: true, data })).toEqual({ accepted: false })
    await vi.advanceTimersByTimeAsync(250)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([failure, { ok: true, data: 42 } as const])('lets another page succeed during error grace: %j', async (bad) => {
    const h = await setup()
    const result = h.query()
    h.answer(bad)
    await vi.advanceTimersByTimeAsync(249)
    expect(h.answer({ ok: true, data: { found: true } })).toEqual({ accepted: true })
    await expect(result).resolves.toEqual({ found: true })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.closed).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('accepts success immediately, snapshots it, and rejects duplicate responses', async () => {
    const h = await setup()
    const result = h.query()
    const data = { found: true }
    expect(h.answer({ ok: true, data })).toEqual({ accepted: true })
    data.found = false
    expect(h.answer(failure)).toEqual({ accepted: false })
    await expect(result).resolves.toEqual({ found: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not let the wrong agent start error grace or win the query', async () => {
    const h = await setup()
    const result = h.query()
    expect(h.answer(failure, otherAgent)).toEqual({ accepted: false })
    expect(h.answer({ ok: true, data: {} }, otherAgent)).toEqual({ accepted: false })
    await vi.advanceTimersByTimeAsync(250)
    expect(h.closed).not.toHaveBeenCalled()
    expect(h.answer({ ok: true, data: {} })).toEqual({ accepted: true })
    await expect(result).resolves.toEqual({})
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels during grace immediately and removes both timers', async () => {
    const h = await setup()
    const result = h.query()
    const rejected = expect(result).rejects.toThrow('was cancelled')
    h.answer(failure)
    h.abort.abort()
    await rejected
    expect(h.answer({ ok: true, data: {} })).toEqual({ accepted: false })
    expect(h.closed).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not broadcast or allocate timers for pre-aborted queries or missing providers', async () => {
    const h = await setup()
    await expect(h.registry.query('client', 'Absent', 'read', undefined, agent, h.abort.signal)).rejects.toThrow('is not registered')
    h.abort.abort()
    await expect(h.query()).rejects.toThrow()
    expect(h.requests).toEqual([])
    expect(h.closed).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never extends the hard deadline for an error grace and preserves the first diagnostic', async () => {
    const h = await setup({ inspectQueryTimeoutMs: 100, inspectQueryErrorGraceMs: 250 })
    const result = h.query()
    const rejected = expect(result).rejects.toThrow(failure.message)
    await vi.advanceTimersByTimeAsync(99)
    h.answer(failure)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles every pending query on registry disposal', async () => {
    const h = await setup()
    const first = expect(h.query()).rejects.toThrow('registry was disposed')
    const second = expect(h.query()).rejects.toThrow('registry was disposed')
    h.answer(failure)
    await fiber.dispose()
    await Promise.all([first, second])
    expect(h.closed).toHaveBeenCalledTimes(2)
    expect(h.answer({ ok: true, data: {} })).toEqual({ accepted: false })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans up immediately when a request listener throws', async () => {
    const h = await setup()
    const remove = vi.spyOn(h.abort.signal, 'removeEventListener')
    h.ctx.on('cordis/inspect-query', () => { throw new Error('dispatch failed') })
    await expect(h.query()).rejects.toThrow('Service.listService: dispatch failed')
    expect(h.closed).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(h.answer({ ok: true, data: {} })).toEqual({ accepted: false })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['timeout', 'grace', 'dispose'] as const)('contains settlement listener errors during %s', async (mode) => {
    const h = await setup()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const notified = vi.fn()
    h.ctx.on('cordis/inspect-query-resolved', () => { throw new Error('notification failed') })
    h.ctx.on('cordis/inspect-query-resolved', notified)
    const message = mode === 'timeout' ? 'timed out' : mode === 'grace' ? failure.message : 'registry was disposed'
    const first = expect(h.query()).rejects.toThrow(message)
    const second = expect(h.query()).rejects.toThrow(message)
    if (mode === 'dispose') await fiber.dispose()
    else {
      if (mode === 'grace') {
        h.answer(failure)
        h.answer(failure, agent, 1)
      }
      await vi.advanceTimersByTimeAsync(mode === 'timeout' ? 30_000 : 250)
    }
    await Promise.all([first, second])
    await vi.waitFor(() => { expect(logged).toHaveBeenCalledTimes(2) })
    expect(notified).toHaveBeenCalledTimes(2)
    expect(h.closed).toHaveBeenCalledTimes(2)
    expect(h.answer({ ok: true, data: {} })).toEqual({ accepted: false })
    expect(h.answer({ ok: true, data: {} }, agent, 1)).toEqual({ accepted: false })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('validates runner configuration and retains VM defaults', () => {
    expect(DynamicCordisRunnerService.Config({})).toMatchObject({
      vmTimeoutMs: 5000, inspectQueryTimeoutMs: 30_000, inspectQueryErrorGraceMs: 250,
    })
    for (const value of [0, -1, Infinity, NaN, 2_147_483_648]) {
      expect(() => DynamicCordisRunnerService.Config({ inspectQueryTimeoutMs: value })).toThrow()
    }
    expect(() => DynamicCordisRunnerService.Config({ inspectQueryErrorGraceMs: -1 })).toThrow()
    expect(DynamicCordisRunnerService.Config({ inspectQueryErrorGraceMs: 0 })).toMatchObject({ inspectQueryErrorGraceMs: 0 })
  })
})
