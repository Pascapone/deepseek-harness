/** Type-only browser messages shared by the desktop shell, Host providers and Client. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Main-issued identity of one guest reservation. */
export type DesktopBrowserLeaseId = Branded<'DesktopBrowserLeaseId'>

/** Host-to-Main request; wire identities are validated by the receiving process. */
export type BrowserCdpRequest = {
  readonly type: 'browser-cdp'
  readonly requestId: number
  readonly sessionId: string
} & (
  | { readonly action: 'open'; readonly lease?: never }
  | { readonly action: 'close'; readonly lease: string }
)

/** Untrusted reply fields; consumers validate the capability before using it. */
export interface BrowserCdpResult {
  readonly type: 'browser-cdp-result'
  readonly requestId: number
  readonly endpoint?: unknown
  readonly lease?: unknown
  readonly tabId?: unknown
  readonly error?: unknown
}

/** Main-verified endpoint for exactly one Session's browser tab. */
export interface BrowserCdpCapability {
  readonly endpoint: string
  readonly lease: string
  readonly tabId: string
}

/** Successful open returns a capability; successful close returns no capability fields. */
export type BrowserCdpSuccess = { readonly type: 'browser-cdp-result'; readonly requestId: number; readonly error?: never }
  & (BrowserCdpCapability | { readonly endpoint?: never; readonly lease?: never; readonly tabId?: never })

/** Main refuses the request without returning a capability. */
export interface BrowserCdpError {
  readonly type: 'browser-cdp-result'
  readonly requestId: number
  readonly error: string
}

/** Main announces readiness without disclosing a Guest lease. */
export interface BrowserGuestReady {
  readonly type: 'browser-guest-ready'
  readonly sessionId: string
}

/** A guest's approved, process-local storage partition. */
export interface DesktopBrowserReservation {
  readonly lease: DesktopBrowserLeaseId
  readonly partition: string
}

/** Main-approved request to open an HTTP(S) page from an existing guest. */
export interface DesktopBrowserOpenRequest {
  readonly lease: DesktopBrowserLeaseId
  readonly url: string
}

/** Origin-scoped operations; no Electron objects or arbitrary IPC cross this interface. */
export interface DesktopBrowserBridge {
  /** @returns one reservation bound to this exact chat Session and Sidebar tab. */
  acquire(workspace: string, sessionId: string, tabId: string): Promise<DesktopBrowserReservation>
  /** @param lease - the caller's reservation. @returns after its guest has been destroyed. */
  release(lease: DesktopBrowserLeaseId): Promise<void>
  reset?(sessionId: string, tabId: string): Promise<boolean>
  /** @param lease - originating guest. @param listener - approved URL consumer. @returns unsubscribe callback. */
  onOpenRequested(lease: DesktopBrowserLeaseId, listener: (url: string) => void): () => void
}
