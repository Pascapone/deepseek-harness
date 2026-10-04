import { EventEmitter, once } from 'node:events'
import { expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { WebContents } from 'electron'
import { openBrowserCdp } from '../src/browser-cdp.ts'

class FakeDebugger extends EventEmitter {
  attached = false
  readonly calls: { method: string; params: unknown; sessionId: string | undefined }[] = []
  attach(): void { this.attached = true }
  isAttached(): boolean { return this.attached }
  detach(): void { this.attached = false; this.emit('detach', {}, 'target_closed') }
  async sendCommand(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
    this.calls.push({ method, params, sessionId })
    if (method === 'Target.getTargetInfo') return { targetInfo: { type: 'webview', targetId: 'private-electron-target',
      browserContextId: 'owned-context', url: 'https://example.com/', title: 'Example Domain' } }
    if (method === 'Page.navigate') return { frameId: 'main-frame' }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'owned-root-frame' } } }
    return {}
  }
}
class FakeGuest extends EventEmitter {
  readonly debugger = new FakeDebugger()
  destroyed = false
  readonly id = 42
  focusedRenderer = false
  readonly hostWebContents = {
    isDestroyed: () => false,
    executeJavaScript: async (code: string) => { this.focusedRenderer = code.includes('getWebContentsId() === 42'); return this.focusedRenderer },
  }
  isDestroyed(): boolean { return this.destroyed }
  destroy(): void { this.destroyed = true; this.emit('destroyed') }
}
type Message = { readonly id?: number; readonly method?: string; readonly sessionId?: string;
  readonly params?: Record<string, unknown>; readonly result?: Record<string, unknown>;
  readonly error?: { readonly message: string } }

function messages(socket: WebSocket): {
  request(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Message>
  event(method: string): Promise<Message>
} {
  const seen: Message[] = []
  socket.on('message', bytes => { seen.push(JSON.parse(bytes.toString()) as Message) })
  let nextId = 0
  return {
    request(method, params = {}, sessionId) {
      const id = ++nextId
      const result = new Promise<Message>((resolve) => {
        const receive = (bytes: WebSocket.RawData): void => {
          const value = JSON.parse(bytes.toString()) as Message
          if (value.id !== id) return
          socket.off('message', receive)
          resolve(value)
        }
        socket.on('message', receive)
      })
      socket.send(JSON.stringify({ id, method, params, ...sessionId === undefined ? {} : { sessionId } }))
      return result
    },
    event(method) {
      const existing = seen.find(value => value.method === method)
      if (existing !== undefined) return Promise.resolve(existing)
      return new Promise<Message>((resolve) => {
        const receive = (bytes: WebSocket.RawData): void => {
          const value = JSON.parse(bytes.toString()) as Message
          if (value.method !== method) return
          socket.off('message', receive)
          resolve(value)
        }
        socket.on('message', receive)
      })
    },
  }
}

async function rejected(url: string, options: ConstructorParameters<typeof WebSocket>[1]): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(url, options)
    socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode ?? 0) })
    socket.once('open', () => { socket.terminate(); reject(new Error('unauthorized CDP socket opened')) })
    socket.once('error', reject)
  })
}

it('exposes only one leased guest, rejects other sockets and targets, and revokes on destruction', async () => {
  const guest = new FakeGuest()
  const cdp = await openBrowserCdp(guest as unknown as WebContents)
  try {
    expect(await rejected(cdp.endpoint, { origin: 'https://evil.example' })).toBe(403)
    expect(await rejected(cdp.endpoint, { headers: { Host: 'evil.example' } })).toBe(403)
    const socket = new WebSocket(cdp.endpoint)
    await once(socket, 'open')
    const c = messages(socket)
    expect(await rejected(cdp.endpoint, {})).toBe(409)

    const discovery = await c.request('Target.getTargets')
    const pages = discovery.result?.targetInfos as { targetId: string; type: string; browserContextId: string }[]
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ targetId: 'owned-root-frame', type: 'page', browserContextId: 'owned-context' })
    expect(JSON.stringify(discovery)).not.toContain('private-electron-target')
    const foreign = await c.request('Target.attachToTarget', { targetId: 'dsh-app-target', flatten: true })
    expect(foreign.error?.message).toBe('Target unavailable')
    expect((await c.request('Target.createTarget', { url: 'https://example.com/' })).error).toBeDefined()

    await c.request('Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: true })
    const attached = await c.event('Target.attachedToTarget')
    expect(attached.params?.targetInfo).toMatchObject({ targetId: pages[0]!.targetId, type: 'page' })
    const sessionId = attached.params?.sessionId as string
    expect(await c.request('Target.setAutoAttach', { autoAttach: true, flatten: true }, sessionId)).toMatchObject({ sessionId })
    const navigation = await c.request('Page.navigate', { url: 'https://example.org/' }, sessionId)
    expect(navigation).toMatchObject({ sessionId, result: { frameId: 'main-frame' } })
    expect(guest.debugger.calls.at(-1)).toEqual({ method: 'Page.navigate', params: { url: 'https://example.org/' }, sessionId: undefined })
    expect(guest.focusedRenderer).toBe(false)
    expect(await c.request('Input.insertText', { text: 'native guest' }, sessionId)).toMatchObject({ sessionId })
    expect(guest.focusedRenderer).toBe(true)
    guest.hostWebContents.executeJavaScript = async () => false
    const beforeInput = guest.debugger.calls.length
    expect((await c.request('Input.insertText', { text: 'denied' }, sessionId)).error?.message).toBe('Guest container unavailable')
    expect(guest.debugger.calls).toHaveLength(beforeInput)
    expect((await c.request('Page.navigate', { url: 'https://bad.example/' }, 'foreign-session')).error).toBeDefined()
    expect(await c.request('Browser.getWindowForTarget', {}, sessionId)).toMatchObject({
      sessionId, error: { message: 'CDP method or target unavailable: Browser.getWindowForTarget' },
    })

    const pageEvent = c.event('Page.loadEventFired')
    guest.debugger.emit('message', {}, 'Page.loadEventFired', { timestamp: 42 }, '')
    expect(await pageEvent).toMatchObject({ sessionId, params: { timestamp: 42 } })
    guest.destroy()
    await once(socket, 'close')
    await cdp.closed
    expect(guest.debugger.isAttached()).toBe(false)
  } finally { await cdp.close() }
})

it('rejects oversized MCP commands without crashing Main or closing the guest', async () => {
  const guest = new FakeGuest()
  const cdp = await openBrowserCdp(guest as unknown as WebContents)
  try {
    const socket = new WebSocket(cdp.endpoint)
    await once(socket, 'open')
    socket.on('error', () => {})
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    socket.send('x'.repeat(8 * 1024 * 1024 + 1))
    await closed
    expect(guest.destroyed).toBe(false)
    expect(guest.debugger.isAttached()).toBe(false)
  } finally { await cdp.close() }
})

it('Browser.close disconnects CDP without closing the desktop guest', async () => {
  const guest = new FakeGuest()
  const cdp = await openBrowserCdp(guest as unknown as WebContents)
  try {
    const socket = new WebSocket(cdp.endpoint)
    await once(socket, 'open')
    const c = messages(socket)
    await c.request('Target.setDiscoverTargets', { discover: true })
    const discovered = await c.event('Target.targetCreated')
    const target = discovered.params?.targetInfo as { targetId: string }
    await c.request('Target.setAutoAttach', { autoAttach: true, flatten: true, filter: [{ type: 'page', exclude: true }] })
    expect((await c.event('Target.attachedToTarget')).params?.targetInfo).toMatchObject({ targetId: target.targetId })
    const closed = once(socket, 'close')
    expect((await c.request('Browser.close')).error).toBeUndefined()
    await closed
    expect(guest.destroyed).toBe(false)
    expect(guest.debugger.isAttached()).toBe(false)
  } finally { await cdp.close() }
})
