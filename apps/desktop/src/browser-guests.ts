/** Main-process ownership and fixed isolation policy for Sidebar webview guests. */
import { createHash, randomUUID } from 'node:crypto'
import { app, session, type BrowserWindow, type Session, type WebContents } from 'electron'
import type { DesktopBrowserLeaseId, DesktopBrowserOpenRequest, DesktopBrowserReservation } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from './ipc.ts'
import { openBrowserCdp } from './browser-cdp.ts'

interface GuestLease {
  readonly owner: WebContents
  readonly partition: string
  readonly sessionId: string
  readonly tabId: string
  readonly workspace: string
  attached: boolean
  guest?: WebContents
  cdp?: Awaited<ReturnType<typeof openBrowserCdp>>
  releaseInput?: () => void
}

/** Owns workspace storage partitions independently from individual tab guests. */
export class DesktopBrowserGuests {
  private readonly partitions = new Map<string, string>()
  private readonly leases = new Map<DesktopBrowserLeaseId, GuestLease>()
  private readonly resetting = new Set<string>()
  private cdpGeneration = 0

  /** @param hostUrl - current authenticated DSH Host, which guests cannot request. */
  constructor(private readonly hostUrl: () => string | undefined,
    private readonly onGuestReady?: (sessionId: string) => void) {}

  /**
   * Reserve one guest in a workspace's dedicated persistent partition.
   * @param owner - authenticated primary application WebContents.
   * @param workspace - workspace identity received over IPC.
   * @returns opaque lease and the partition approved for it.
   */
  acquire(owner: WebContents, workspace: unknown, sessionId: unknown, tabId: unknown): DesktopBrowserReservation {
    if (typeof workspace !== 'string' || workspace.length === 0 || workspace.length > 4096) {
      throw new Error('desktop browser: a workspace storage identity is required')
    }
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128
      || typeof tabId !== 'string' || !tabId || tabId.length > 128) {
      throw new Error('desktop browser: a Session and tab identity are required')
    }
    let partition = this.partitions.get(workspace)
    if (partition === undefined) {
      partition = `persist:dsh-sidebar-browser-v1-${createHash('sha256').update(workspace).digest('hex')}`
      this.configureSession(session.fromPartition(partition))
      this.partitions.set(workspace, partition)
    }
    if (this.resetting.has(partition)) throw new Error('desktop browser: Workspace website data is being reset')
    const lease = randomUUID() as DesktopBrowserLeaseId
    this.leases.set(lease, { owner, partition, sessionId, tabId, workspace, attached: false })
    return { lease, partition }
  }

  /** Resolve only the requesting app's exact tab before opening a human confirmation. */
  resetTarget(owner: WebContents, sessionId: unknown, tabId: unknown): { lease: DesktopBrowserLeaseId; workspace: string } {
    const matches = [...this.leases].filter(([, value]) => value.owner === owner
      && value.sessionId === sessionId && value.tabId === tabId)
    const [match] = matches
    if (matches.length !== 1 || match === undefined) throw new Error('desktop browser: expected exactly one owned tab')
    const [lease, value] = match
    return { lease, workspace: value.workspace }
  }

  /** Revoke all affected Guests before clearing only their shared website-storage partition. */
  async reset(owner: WebContents, id: DesktopBrowserLeaseId): Promise<void> {
    const target = this.leases.get(id)
    if (target?.owner !== owner) throw new Error('desktop browser: Guest lease expired')
    const partition = target.partition
    if (this.resetting.has(partition)) throw new Error('desktop browser: reset already in progress')
    this.resetting.add(partition)
    try {
      for (const [leaseId, value] of [...this.leases]) {
        if (value.partition === partition) await this.release(value.owner, leaseId)
      }
      const storage = session.fromPartition(partition)
      await storage.clearStorageData()
      await storage.clearCache()
    } finally { this.resetting.delete(partition) }
  }

  /** Give one live Agent a revocable endpoint for its single mounted Sidebar tab. */
  async openSessionCdp(sessionId: string): Promise<{ endpoint: string; lease: DesktopBrowserLeaseId; tabId: string }> {
    const matches = [...this.leases].filter(([, lease]) => lease.sessionId === sessionId && lease.guest
      && !lease.guest.isDestroyed() && !lease.owner.isDestroyed())
    // ponytail: ambiguous multi-tab Sessions fail closed; add an explicit tab picker if parallel tabs need Agents.
    const [match] = matches
    if (matches.length !== 1 || match === undefined) throw new Error('desktop browser: expected exactly one live Session guest')
    const [id, lease] = match
    if (lease.cdp !== undefined) throw new Error('desktop browser: Guest already attached to an Agent')
    const guest = lease.guest
    if (guest === undefined) throw new Error('desktop browser: Guest lease expired')
    const generation = this.cdpGeneration
    const cdp = await openBrowserCdp(guest)
    if (generation !== this.cdpGeneration || this.leases.get(id) !== lease || guest.isDestroyed() || lease.owner.isDestroyed()) {
      await cdp.close()
      throw new Error('desktop browser: Guest lease expired')
    }
    lease.cdp = cdp
    void cdp.closed.then(() => { if (lease.cdp === cdp) delete lease.cdp })
    return { endpoint: cdp.endpoint, lease: id, tabId: lease.tabId }
  }

  async closeSessionCdp(sessionId: string, id: string): Promise<void> {
    const lease = this.leases.get(id as DesktopBrowserLeaseId)
    if (lease?.sessionId !== sessionId) return
    const cdp = lease.cdp
    delete lease.cdp
    await cdp?.close()
  }

  async closeAllCdp(): Promise<void> {
    this.cdpGeneration++
    await Promise.all([...this.leases].map(([id, lease]) => this.closeSessionCdp(lease.sessionId, id)))
  }

  /**
   * Release only a lease issued to this application window; workspace storage survives.
   * @param owner - authenticated IPC sender.
   * @param id - lease received over IPC.
   */
  async release(owner: WebContents, id: unknown): Promise<void> {
    if (typeof id !== 'string') throw new Error('desktop browser: invalid guest lease')
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    if (lease === undefined) return
    if (lease.owner !== owner) throw new Error('desktop browser: guest belongs to another window')
    lease.releaseInput?.()
    this.leases.delete(key)
    if (lease.cdp) await lease.cdp.close()
    const guest = lease.guest
    if (guest !== undefined && !guest.isDestroyed()) {
      const destroyed = new Promise<void>((resolve) => { guest.once('destroyed', resolve) })
      guest.close({ waitForBeforeUnload: false })
      await destroyed
    }
  }

  /**
   * Install attachment checks before the application document can create a webview.
   * @param window - primary application window.
   * @param attachInput - attaches native input after guest ownership is verified and returns its disposer.
   */
  bind(window: BrowserWindow, attachInput: (guest: WebContents, name: DesktopBrowserLeaseId) => () => void): void {
    const owner = window.webContents
    owner.on('will-attach-webview', (event, preferences, params) => {
      const id = typeof params.src === 'string' && params.src.startsWith('about:blank#')
        ? params.src.slice('about:blank#'.length) : ''
      const lease = this.leases.get(id as DesktopBrowserLeaseId)
      if (lease === undefined || lease.owner !== owner || lease.attached || params.partition !== lease.partition) {
        event.preventDefault()
        return
      }
      lease.attached = true
      // Keep Electron's allowpopups dispatch flag; the guest handler still denies native windows.
      for (const key of Object.keys(preferences)) {
        if (key !== 'disablePopups') Reflect.deleteProperty(preferences, key)
      }
      Object.assign(preferences, {
        partition: lease.partition,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, plugins: false, navigateOnDragDrop: false, disableDialogs: true,
        devTools: !app.isPackaged,
      })
      params.httpreferrer = ''
    })
    owner.on('did-attach-webview', (_event, guest) => {
      let attachedLease: DesktopBrowserLeaseId | undefined
      // The first document is an inert about:blank carrying the approved lease.
      // Bind on the main-process event before the renderer can navigate the ready guest.
      guest.once('dom-ready', () => {
        const url = guest.getURL()
        const id = (url.startsWith('about:blank#') ? url.slice('about:blank#'.length) : '') as DesktopBrowserLeaseId
        const lease = this.leases.get(id)
        if (lease === undefined || lease.owner !== owner || lease.guest !== undefined) {
          guest.close({ waitForBeforeUnload: false })
          return
        }
        lease.guest = guest
        attachedLease = id
        lease.releaseInput = attachInput(guest, id)
        this.onGuestReady?.(lease.sessionId)
        guest.once('destroyed', () => { lease.releaseInput?.(); this.leases.delete(id) })
      })
      guest.setWindowOpenHandler(({ url, postBody }) => {
        const lease = attachedLease === undefined ? undefined : this.leases.get(attachedLease)
        if (attachedLease !== undefined && lease?.guest === guest && lease.owner === owner && !owner.isDestroyed()
          && postBody === undefined && this.allowedNavigation(url)) {
          const request: DesktopBrowserOpenRequest = { lease: attachedLease, url: new URL(url).href }
          owner.send(DESKTOP_IPC.browserOpenRequested, request)
        }
        return { action: 'deny' }
      })
      guest.on('will-frame-navigate', (event) => {
        if (event.isMainFrame && !this.allowedNavigation(event.url)) event.preventDefault()
      })
      guest.on('will-redirect', (event, url, _inPlace, mainFrame) => {
        if (mainFrame && !this.allowedNavigation(url)) event.preventDefault()
      })
      guest.on('will-attach-webview', (event) => { event.preventDefault() })
      guest.on('login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback() })
    })
    const releaseAll = (): void => {
      for (const [id, lease] of this.leases) {
        if (lease.owner === owner) void this.release(owner, id).catch((error: unknown) => { console.error(error) })
      }
    }
    owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) releaseAll()
    })
    owner.on('render-process-gone', releaseAll)
    owner.once('destroyed', releaseAll)
  }

  private configureSession(browserSession: Session): void {
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setDevicePermissionHandler(() => false)
    browserSession.setDisplayMediaRequestHandler((_request, callback) => { callback({}) })
    browserSession.on('will-download', (event) => { event.preventDefault() })
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      const network = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      callback({ cancel: network
        ? url.username !== '' || url.password !== '' || this.isApplicationHost(url)
        : !['about:', 'data:', 'blob:'].includes(url.protocol) })
    })
  }

  private allowedNavigation(value: string): boolean {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === ''
      && !this.isApplicationHost(url)
  }

  private isApplicationHost(url: URL): boolean {
    const value = this.hostUrl()
    if (value === undefined) return false
    const host = new URL(value)
    return url.port === host.port
      && (url.hostname === host.hostname || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  }
}
