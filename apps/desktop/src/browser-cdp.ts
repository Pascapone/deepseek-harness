/** Disposable browser-level CDP facade over one Main-verified Sidebar guest. Not a general Chromium endpoint. */
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { WebContents } from 'electron'
import { WebSocket, WebSocketServer } from 'ws'

// ponytail: bounded page subset; add only commands proven necessary by an isolated MCP trace.
const PAGE_COMMANDS = new Set([
  'Page.enable', 'Page.disable', 'Page.navigate', 'Page.reload', 'Page.getFrameTree', 'Page.captureScreenshot',
  'Page.setLifecycleEventsEnabled', 'Page.addScriptToEvaluateOnNewDocument', 'Page.createIsolatedWorld',
  'Page.setInterceptFileChooserDialog',
  'Network.enable', 'Network.disable',
  'Runtime.enable', 'Runtime.disable', 'Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.getProperties',
  'Runtime.releaseObject', 'Runtime.runIfWaitingForDebugger', 'Log.enable', 'Log.disable', 'Audits.enable',
  'Performance.enable', 'Accessibility.getFullAXTree',
  'DOM.enable', 'DOM.disable', 'DOM.getDocument', 'DOM.querySelector', 'DOM.querySelectorAll',
  'DOM.describeNode', 'DOM.getBoxModel', 'DOM.getContentQuads', 'DOM.resolveNode', 'DOM.scrollIntoViewIfNeeded',
  // ponytail: hidden Guests ignore mouse events; use an offscreen input backend if hidden clicks are required.
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText',
  'Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride',
  'Emulation.setFocusEmulationEnabled', 'Emulation.setEmulatedMedia',
])
const PAGE_EVENTS = /^(?:Page|Network|Runtime|Log|Audits|Performance|DOM|Input|Emulation)\.[A-Za-z]+$/u

type Guest = Pick<WebContents, 'debugger' | 'isDestroyed' | 'id'> & {
  readonly hostWebContents: Pick<WebContents, 'isDestroyed' | 'executeJavaScript'> | null
  on(event: 'destroyed', listener: () => void): void
  off(event: 'destroyed', listener: () => void): void
}
type Command = {
  readonly id: number
  readonly method: string
  readonly params?: Record<string, unknown> | null
  readonly sessionId?: string
}
type TargetInfo = {
  readonly targetId: string
  readonly type: 'page'
  readonly browserContextId: string
  readonly url: string
  readonly title: string
  readonly attached: boolean
}

/** Caller must verify the guest's application window, tab lease, and Agent before opening this one-use endpoint. */
export async function openBrowserCdp(
  guest: Guest,
): Promise<{ readonly endpoint: string; close(): Promise<void>; readonly closed: Promise<void> }> {
  if (guest.isDestroyed() || guest.debugger.isAttached()) throw new Error('desktop browser CDP: guest unavailable')
  guest.debugger.attach('1.3')
  let info: { url: string | undefined; title: string | undefined; browserContextId: string | undefined }
  let targetId: string
  try {
    const reply: unknown = await guest.debugger.sendCommand('Target.getTargetInfo')
    if (typeof reply !== 'object' || reply === null || !('targetInfo' in reply)) throw new Error('missing guest target')
    const targetInfo = reply.targetInfo
    if (typeof targetInfo !== 'object' || targetInfo === null) throw new Error('missing guest target')
    info = {
      url: 'url' in targetInfo && typeof targetInfo.url === 'string' ? targetInfo.url : undefined,
      title: 'title' in targetInfo && typeof targetInfo.title === 'string' ? targetInfo.title : undefined,
      browserContextId: 'browserContextId' in targetInfo && typeof targetInfo.browserContextId === 'string'
        ? targetInfo.browserContextId : undefined,
    }
    if (typeof info.browserContextId !== 'string' || !info.browserContextId) throw new Error('missing guest context')
    if (guest.isDestroyed() || (typeof info.url === 'string' && info.url.startsWith('dsh-app:'))) {
      throw new Error('guest unavailable or application target')
    }
    const frame: unknown = await guest.debugger.sendCommand('Page.getFrameTree')
    const id = (frame as { frameTree?: { frame?: { id?: unknown } } } | null | undefined)?.frameTree?.frame?.id
    if (typeof id !== 'string' || !id || id.length > 128) throw new Error('missing guest main frame')
    // Playwright keys its main-frame session by TargetId; the ID must match this guest's real frame.
    targetId = id
  } catch (error) {
    if (guest.debugger.isAttached()) guest.debugger.detach()
    throw error
  }

  const sessionId = randomUUID()
  const contextId = info.browserContextId
  let url = info.url?.startsWith('about:blank') ? 'about:blank' : info.url ?? 'about:blank'
  let attached = false
  let client: WebSocket | undefined
  let used = false
  let idleTimer: NodeJS.Timeout | undefined
  let closing: Promise<void> | undefined
  const isClosing = (): boolean => closing !== undefined
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve })
  const path = `/cdp/${randomBytes(32).toString('hex')}`
  const server = createServer((_req, response) => { response.writeHead(404).end() })
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 })
  const target = (): TargetInfo => ({ targetId, type: 'page', browserContextId: contextId, url,
    title: typeof info.title === 'string' ? info.title : '', attached })
  const send = (value: unknown): void => {
    if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(value))
  }
  const event = (method: string, params: unknown, page = false): void => {
    send({ method, params, ...page ? { sessionId } : {} })
  }
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing
    clearTimeout(idleTimer)
    guest.off('destroyed', onGone)
    guest.debugger.off('detach', onGone)
    guest.debugger.off('message', onMessage)
    client?.terminate()
    sockets.close()
    closing = new Promise<void>((resolve) => { server.close(() => { resolve(); resolveClosed() }) })
    if (guest.debugger.isAttached()) guest.debugger.detach()
    return closing
  }
  const onGone = (): void => { void close() }
  const onMessage = (_event: unknown, method: string, params: unknown, nativeSessionId?: string): void => {
    // No arbitrary child/other target's CDP messages enter this synthetic session.
    if (!nativeSessionId && attached && PAGE_EVENTS.test(method)) event(method, params, true)
  }
  guest.on('destroyed', onGone)
  guest.debugger.on('detach', onGone)
  guest.debugger.on('message', onMessage)

  async function command(input: Command): Promise<void> {
    const { id, method, params = {}, sessionId: incoming } = input
    const fail = (message: string): void => {
      send({ id, error: { code: -32000, message }, ...incoming === sessionId ? { sessionId } : {} })
    }
    if (typeof method !== 'string' || !Number.isSafeInteger(id) || id < 0 || typeof params !== 'object' || params === null
      || Array.isArray(params) || (incoming !== undefined && incoming !== sessionId)) {
      fail('Invalid CDP command or session')
      return
    }
    if (guest.isDestroyed() || !guest.debugger.isAttached()) { fail('Guest unavailable'); void close(); return }
    if ((params.targetId !== undefined && params.targetId !== targetId)
      || (params.sessionId !== undefined && params.sessionId !== sessionId)
      || (params.browserContextId !== undefined && params.browserContextId !== contextId)) {
      fail('Target unavailable')
      return
    }
    let result: unknown = {}
    if (method === 'Browser.close' && incoming === undefined) {
      send({ id, result })
      client?.close()
      return
    }
    if (method === 'Browser.getVersion' && incoming === undefined) {
      const chrome = process.versions.chrome
      const platform = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
        : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64'
      result = { protocolVersion: '1.3', product: `Chrome/${chrome}`, revision: '@guest',
        userAgent: `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`,
        jsVersion: process.versions.v8 }
    } else if (method === 'Target.getBrowserContexts' && incoming === undefined) {
      result = { browserContextIds: [contextId] }
    } else if (method === 'Target.getTargets' && incoming === undefined) {
      result = { targetInfos: [target()] }
    } else if (method === 'Target.getTargetInfo' && (incoming === undefined || incoming === sessionId)) {
      result = { targetInfo: target() }
    } else if (method === 'Target.setDiscoverTargets' && incoming === undefined && typeof params.discover === 'boolean') {
      send({ id, result })
      if (params.discover) event('Target.targetCreated', { targetInfo: target() })
      return
    } else if (method === 'Target.setAutoAttach' && (incoming === undefined || incoming === sessionId)
      && typeof params.autoAttach === 'boolean' && params.flatten === true) {
      // ponytail: page-level auto-attach is a no-op; map verified child targets only if OOPIF tools are required.
      // Puppeteer excludes pages expecting a parent tab; this facade has one guest page and no parent tab.
      if (incoming === undefined && params.autoAttach && !attached) {
        attached = true
        event('Target.attachedToTarget', { sessionId, targetInfo: target(), waitingForDebugger: false })
      }
      send({ id, result, ...incoming === sessionId ? { sessionId } : {} })
      return
    } else if (method === 'Target.attachToTarget' && incoming === undefined
      && params.targetId === targetId && params.flatten === true) {
      if (!attached) {
        attached = true
        event('Target.attachedToTarget', { sessionId, targetInfo: target(), waitingForDebugger: false })
      }
      send({ id, result: { sessionId } })
      return
    } else if (incoming === sessionId && attached && PAGE_COMMANDS.has(method)) {
      if (method === 'Page.navigate' && (typeof params.url !== 'string' ||
        !/^https?:\/\//u.test(params.url))) { fail('Navigation URL unavailable'); return }
      try {
        // The debugger is already attached to this page: never pass the synthetic session id to Chromium.
        if (method === 'Input.insertText' || method === 'Input.dispatchKeyEvent') {
          // Guest.focus() alone does not focus the embedding webview; text otherwise lands nowhere.
          const host = guest.hostWebContents
          if (host === null || host.isDestroyed()) throw new Error('Guest container unavailable')
          const focused: unknown = await host.executeJavaScript(`(() => {
            const matches = [...document.querySelectorAll('webview')]
              .filter(element => element.getWebContentsId() === ${guest.id})
            if (matches.length !== 1) return false
            matches[0].focus()
            return document.activeElement === matches[0]
          })()`)
          if (focused !== true) throw new Error('Guest container unavailable')
        }
        result = await guest.debugger.sendCommand(method, params)
      } catch (error) {
        fail(error instanceof Error ? error.message : 'Guest command failed')
        return
      }
      if (method === 'Page.navigate') {
        url = params.url as string
        event('Target.targetInfoChanged', { targetInfo: target() })
      }
    } else {
      fail(`CDP method or target unavailable: ${/^[A-Za-z]+\.[A-Za-z]+$/u.test(method) ? method : 'unknown'}`)
      return
    }
    send({ id, result, ...incoming === sessionId ? { sessionId } : {} })
  }

  server.on('upgrade', (request, socket: Socket, head) => {
    const address = server.address() as AddressInfo | null
    const host = address === null ? '' : `127.0.0.1:${address.port}`
    const status = request.url !== path || request.headers.host !== host || request.headers.origin !== undefined
      ? 403 : used || closing !== undefined ? 409 : 0
    if (status) { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return }
    used = true
    clearTimeout(idleTimer)
    sockets.handleUpgrade(request, socket, head, (connection) => {
      client = connection
      connection.on('message', (data, binary) => {
        if (binary) { connection.close(1003); return }
        let input: unknown
        const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
        try { input = JSON.parse(bytes.toString('utf8')) } catch { connection.close(1007); return }
        if (typeof input !== 'object' || input === null || !('id' in input)) { connection.close(1007); return }
        void command(input as Command)
      })
      connection.once('error', () => { void close() })
      connection.once('close', () => { void close() })
    })
  })
  try {
    if (guest.isDestroyed() || closing !== undefined) throw new Error('guest destroyed before CDP listener started')
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    if (guest.isDestroyed() || isClosing()) {
      if (server.listening) await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      throw new Error('guest destroyed before CDP listener started')
    }
    server.on('error', onGone)
    // One-use token expires if its MCP never connects; an active client lives until lease teardown.
    // ponytail: unclaimed endpoints expire after one day; renew on Agent wake if longer idle Sessions matter.
    idleTimer = setTimeout(onGone, 24 * 60 * 60_000)
    idleTimer.unref()
    const address = server.address() as AddressInfo
    return { endpoint: `ws://127.0.0.1:${address.port}${path}`, close, closed }
  } catch (error) { await close(); throw error }
}
