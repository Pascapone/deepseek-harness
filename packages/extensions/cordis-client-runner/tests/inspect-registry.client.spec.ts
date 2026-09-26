import { describe, expect, it, vi } from 'vitest'
import type { CordisInspectQueryRequest, CordisInspectRequestId, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { ClientCordisInspectRegistry } from '../src/client/inspect-registry.ts'
import { Context } from '@deepseek-ai/cordis'
import { clientInspectProviders } from '../src/client/providers.ts'

const request = {
  requestId: 'inspect-missing' as CordisInspectRequestId, agentId: 'inspect-owner' as SessionId,
  provider: 'Service', method: 'listService', input: { service: 'sidebarRight' },
} satisfies CordisInspectQueryRequest

describe('Client inspect failure transport', () => {
  it('sends a missing static service as provider-error, without claiming the runtime service is absent', async () => {
    const resolve = vi.fn(async () => {})
    const registry = new ClientCordisInspectRegistry({ sync: async () => {}, resolve })
    const provider = clientInspectProviders(new Context()).find(item => item.manifest.id === 'Service')!
    const dispose = registry.register(provider)
    await registry.query(request)
    expect(resolve).toHaveBeenCalledExactlyOnceWith(request.agentId, request.requestId, {
      ok: false, reason: 'provider-error', message: 'no catalogued Service named "sidebarRight"',
    })
    dispose()
    resolve.mockClear()
    await registry.query(request)
    expect(resolve).toHaveBeenCalledExactlyOnceWith(request.agentId, request.requestId, {
      ok: false, reason: 'provider-missing', message: 'Client inspect provider "Service" is unavailable',
    })
  })

  it('aborts local work and suppresses late answers after Host settlement', async () => {
    const resolve = vi.fn(async () => {})
    const registry = new ClientCordisInspectRegistry({ sync: async () => {}, resolve })
    let finish!: () => void
    let signal!: AbortSignal
    const dispose = registry.register({
      manifest: {
        id: 'Service', description: 'Delayed provider',
        methods: [{ name: 'listService', description: 'Read', inputSchema: {}, outputSchema: {} }],
      },
      query: async (_method, _input, context) => {
        signal = context.signal
        await new Promise<void>((resolve) => { finish = resolve })
        return {}
      },
    })
    const pending = registry.query(request)
    registry.close(request.requestId)
    expect(signal.aborted).toBe(true)
    finish()
    await pending
    expect(resolve).not.toHaveBeenCalled()
    dispose()
  })
})
