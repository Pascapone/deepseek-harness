/**
 * `ctx.sidebarRight`: what other plugins may ask of this column.
 *
 * The surface is per session and its state lives in that session's store
 * instance, which the slot runtime mints per session and a root service cannot
 * reach on its own. Two paths lead in. The mounted seat publishes its binding —
 * session id, bound actions, its surface — for exactly as long as it is mounted,
 * and every command on the public face goes through that binding; a command
 * arriving with no seat mounted has no session to act on and fails loudly rather
 * than writing into a surface nobody is drawing. `mounted` publishes that
 * binding's session as an observable, so a consumer that wants to open content
 * as soon as a seat is on screen subscribes to it instead of assuming one is
 * bound when its own effect runs. And the plugin adopts each
 * session's store instance as the runtime mints it, so the controller reaches
 * any session's store by id and syncs the Tab domain from that store's commits.
 *
 * A tab's own actions (`tabActions`) aim at the session the tab is in, not at
 * the mounted one: they run through that session's adopted store, so a callback
 * fired after the user switched sessions still lands where its tab is, and they
 * do nothing for a session whose store was never minted.
 *
 * `openResource` and `openTab` are the navigation controller, and every way
 * into the column is a call to one of them: the conversation's file links, a
 * tool row's line reference, the strip's add control, a guide entry box, a file
 * tree's rows. A resource is claimed through the registry by address; a page is
 * named by kind and recorded at the address this package composes for it. Both
 * hand the store one settled intent and record the navigation in the Tab
 * domain. Placement is the caller's option, never a type's property.
 *
 * The registration adopts Session stores and injects the mounted seat binding;
 * callers use the service's navigation methods.
 */
import { sidebarTargetFromElement, type SidebarRightTarget } from './focus.ts'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { FloatRect, LayoutState, PaneId, SplitAxis, TabId, TabRecord } from '@deepseek-ai/dsh-client-ui-dockkit'
import { activeDockPaneId, findContentTab, findTabPane, getPane } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SidebarRightNavigationParams, SidebarRightResourceParams, SidebarRightTabParamsFor } from './contract/params.ts'
import { pageAddress } from './contract/seed.ts'
import type { SidebarRightTabClaim, SidebarRightTabRegistry } from './tab-registry.ts'
import { canCloseTab, splitAllowed, type SidebarRightState, type SurfaceState } from './stores.ts'
import type { createSidebarRightStore } from './stores.ts'
import { TabDomain, type PinResource } from './tab-domain.ts'
import { SidebarTabInventory } from './tab-inventory.ts'

/** The seat's bound action set. */
export type SurfaceActions = BoundActions<ReturnType<typeof createSidebarRightStore>>

/** One session's store instance as the slot runtime minted it: its actions and its observable snapshot. */
export interface SidebarRightSurfaceStore {
  readonly actions: SurfaceActions
  getSnapshot(): SidebarRightState
  subscribe(listener: () => void): () => void
}

/** One adoption of a session's store; the token a release compares against. */
interface Adoption {
  readonly store: SidebarRightSurfaceStore
  readonly unsubscribe: () => void
}

/**
 * Create the public controller and the plugin-private store adoption callback.
 * Adoption reconciles restored records before any seat renders, then follows commits.
 * @param tabs - registered tab types.
 * @param pin - resource retention for an occurrence's lifetime.
 * @returns the controller and plugin-owned adoption and scope-removal callbacks.
 */
export function createSidebarRightController(tabs: SidebarRightTabRegistry, pin: PinResource,
  retainPinned?: (sessionId: SessionId, tabId: TabId, pinned: boolean) => void): {
  controller: SidebarRightController
  adopt: (sessionId: SessionId, store: SidebarRightSurfaceStore) => () => void
  forget: (sessionId: SessionId) => void
} {
  const adopted = new Map<SessionId, Adoption>()
  const inventory = new SidebarTabInventory()
  const controller = new SidebarRightController(tabs, pin, adopted, inventory.source, retainPinned)
  return {
    controller,
    forget: (sessionId) => { inventory.remove(sessionId) },
    adopt(sessionId, store) {
      adopted.get(sessionId)?.unsubscribe()
      const sync = (): void => {
        const surface = store.getSnapshot().bySession[sessionId]
        inventory.update(sessionId, Object.values(surface?.layout.tabs ?? {}))
        if (surface !== undefined) {
          controller.tabDomain.sync(sessionId, surface.layout)
          controller.reconcileWindows(sessionId, surface.layout)
          controller.resumeWindows(sessionId)
        }
      }
      const adoption: Adoption = { store, unsubscribe: store.subscribe(sync) }
      adopted.set(sessionId, adoption)
      sync()
      return () => {
        adoption.unsubscribe()
        if (adopted.get(sessionId) === adoption) adopted.delete(sessionId)
      }
    },
  }
}

/** Everything a command needs, as the mounted seat sees it. */
export interface SidebarRightBinding {
  /** The session the mounted seat is drawing. */
  readonly sessionId: SessionId
  /** The seat's store's bound actions; every action names the session it acts on. */
  readonly actions: SurfaceActions
  /**
   * The seat's store surfaces as last committed, keyed by session id; the
   * mounted session's is `surfaces[sessionId]`, absent before the seat's first
   * open. The runtime mints one store per session, so this holds that session.
   */
  readonly surfaces: Readonly<Record<string, SurfaceState>>
  /**
   * The room rule's verdict for a docked pane, as the kit last measured it:
   * whether two working halves would fit. Unmeasured panes fit.
   */
  readonly canSplitPane: (paneId: PaneId, axis: SplitAxis) => boolean
  /** Commit a keyboard/menu close and retain focus on a surviving visible pane. */
  readonly closeWithFocus: (paneId: PaneId, close: () => void) => void
  /** Commit a page operation and focus the pane it selects. */
  readonly openWithFocus: (open: () => PaneId | undefined) => void
  /** Narrow viewports present an expanded panel fullscreen. */
  readonly autoFullscreen?: boolean
}

/** Where an open lands; every field is optional and the defaults are the common case. */
export interface SidebarRightPlacement {
  /** Land a new tab in this pane instead of the active docked one. */
  readonly paneId?: PaneId
  /** Prefer a new pane for new content; use the target pane when splitting is unavailable. */
  readonly preferNewPane?: boolean
  /** Take this tab's place — its pane and its strip slot — and close it in the same step. */
  readonly replaceTab?: TabId
  /**
   * Resource tabs reveal an existing (kind, contentId) by default; `false`
   * permits duplicates. Pages always deduplicate within the target pane.
   */
  readonly revealIfOpened?: boolean
}

/** How a caller wants a resource opened. */
export interface SidebarRightOpenResourceOptions extends SidebarRightPlacement {
  /** Name the opening type instead of letting the registry rank claims; its `canOpen` still applies. */
  readonly kind?: string
  /** The resource's navigation parameters, typed by resource type; delivered as `navigation.params`. */
  readonly params?: SidebarRightResourceParams
}

/** How a caller wants a page type opened. */
export interface SidebarRightOpenTabOptions<K extends string = string> extends SidebarRightPlacement {
  /** That kind's navigation parameters, typed by kind; delivered as `navigation.params`. */
  readonly params?: SidebarRightTabParamsFor<K>
}

/** The scheme every resource address carries; anything else is not a resource this face opens. */
const RESOURCE_SCHEME = 'dsh-resource://'

/** Synchronous close/replacement hook; resource owners retain any background cleanup. */
export type SidebarRightCloseHandler = (sessionId: SessionId, tab: TabRecord) => void

/** The outward right-Sidebar face (`ctx.sidebarRight`). */
export interface ISidebarRight {
  /**
   * The session whose seat is mounted, or `undefined` while no seat is on
   * screen (a global panel is active, or no session is selected). Moves when a
   * seat binds or releases, so a component that opens content from its own
   * mount effect reads it through a bound hook and acts once it is defined:
   * the frame mounts the Conversation column ahead of the seat, and the seat
   * publishes its binding from a passive effect of the same commit.
   */
  readonly mounted: ObservableSnapshot<SessionId | undefined>
  /**
   * Open a resource: claim it, place it, reveal the column, record the navigation.
   *
   * Without `options.kind` the registry ranks the types whose globs and
   * `canOpen` accept the address and the best band wins; with it, that kind's
   * type in force opens the address (its `canOpen` still applies). An address
   * outside `dsh-resource://`, or one no type will open, is a wiring mistake,
   * not a user error, so it throws. The column expands in the same step,
   * because content the user cannot see is not opened.
   * @param address - a `dsh-resource://<type>/…` address.
   * @param options - placement, the opening type, and navigation parameters.
   */
  openResource(address: string, options?: SidebarRightOpenResourceOptions): void
  /**
   * Open a page type by kind: the type in force for it, at the address this
   * package records pages under. A kind nothing registered throws.
   * @param kind - the page type's kind.
   * @param options - placement and that kind's navigation parameters.
   */
  openTab<K extends string>(kind: K, options?: SidebarRightOpenTabOptions<K>): void
  /**
   * Close one tab of the mounted session; the sole docked guide remains open.
   * @param tabId - the tab to close.
   */
  close(tabId: TabId): void
  /** Close a tab in its own Session, including an inactive detached tab; the sole docked guide remains. */
  closeIn(sessionId: SessionId, tabId: TabId): void
  /**
   * The active tab of the active pane.
   * @returns the record, or `undefined` when no seat is mounted.
   */
  active(): TabRecord | undefined
  /**
   * Whether the column is currently showing its panel.
   * @returns `true` while expanded; `false` while collapsed to its rail.
   */
  isExpanded(): boolean
  /** Collapse the column, or expand it and focus its active dock pane. Recorded in the sequence. */
  toggleExpanded(): void
  /**
   * Focus a tab and the pane holding it, raising a floating one. Recorded.
   * @param tabId - the tab; one that does not exist is left alone.
   */
  focus(tabId: TabId): void
  /**
   * Split a docked pane to the right or below and seed the new pane, under the
   * same per-axis limit and room rule as the strip controls. Recorded when split.
   * @param paneId - the pane to split; defaults to the active docked pane.
   * @param axis - row splits left/right, column splits top/bottom; defaults to row.
   * @returns the new pane's id, or `undefined` when nothing was split: the pane
   *   is missing, floating, or empty, the budget is spent, or two halves would not fit.
   */
  split(paneId?: PaneId, axis?: SplitAxis): PaneId | undefined
  /**
   * Take a docked tab out into a floating panel. Recorded.
   * @param tabId - the tab; one that is missing or already floating is left alone.
   * @param rect - the panel's rectangle; defaults to the cascade from the last panel.
   */
  float(tabId: TabId, rect?: FloatRect): void
  /**
   * Return a floating panel's tab to the active docked pane. Recorded.
   * @param paneId - the floating pane; one that is missing or docked is left alone.
   */
  dock(paneId: PaneId): void
  /** Open one tab in a satellite browser window, leaving its layout owned by this page. */
  popout(tabId: TabId, rect?: FloatRect): boolean
  /** Install the window creator; no popup behavior exists without an explicit Web plugin. */
  registerWindowOpener(open: (tab: TabRecord, bounds?: FloatRect) => Window | null): () => void
  /** Copy a recorded tab into the mounted Session without removing its source. */
  copyToMounted(tab: Pick<TabRecord, 'kind' | 'contentId' | 'title'>): TabId
  /** Keep a detached window and its source Session view alive across selections. */
  setPinned(sessionId: SessionId, tabId: TabId, pinned: boolean): void
}

type Satellite = { window: Window; target: HTMLElement; tabId: TabId; paneId: PaneId; sessionId: SessionId; stop: () => void }
type ParkedSatellite = { tabId: TabId; paneId: PaneId; sessionId: SessionId; bounds: FloatRect }

/** Cross-plugin right-Sidebar face (ctx.sidebarRight). */
export class SidebarRightController implements ISidebarRight {
  /** Open tab metadata across saved and adopted Sessions, independent of visible seats. */
  readonly openTabs: SidebarTabInventory['source']
  private readonly mountedSession = createSnapshotStore<SessionId | undefined>(undefined)
  /** The mounted seat's session; see {@link ISidebarRight.mounted}. */
  readonly mounted: ObservableSnapshot<SessionId | undefined> = this.mountedSession
  private binding: SidebarRightBinding | undefined
  private readonly closeHandlers = new Map<string, SidebarRightCloseHandler>()
  private windowOpener: ((tab: TabRecord, bounds?: FloatRect) => Window | null) | undefined
  private readonly windows = new Map<string, Satellite>()
  private readonly parked = new Map<string, ParkedSatellite>()
  private readonly pinned = new Set<string>()
  private activeSession: SessionId | undefined
  private resumeSession: SessionId | undefined
  readonly popouts = createSnapshotStore<ReadonlyMap<string, HTMLElement | undefined>>(new Map())

  /**
   * Register resource cleanup before explicit removal. Failure preserves the tab.
   * @param kind - tab kind owned by the registering plugin.
   * @param handler - saves any background cleanup before returning and allowing removal.
   * @returns an effect-scoped unregister callback.
   */
  registerCloseHandler(kind: string, handler: SidebarRightCloseHandler): () => void {
    if (this.closeHandlers.has(kind)) throw new Error(`sidebarRight: close handler already registered for ${kind}`)
    this.closeHandlers.set(kind, handler)
    return () => { if (this.closeHandlers.get(kind) === handler) this.closeHandlers.delete(kind) }
  }

  /**
   * The Tab domain this controller navigates into; synced from each adopted
   * store's commits, read by the seat for each body's owner share.
   */
  readonly tabDomain: TabDomain

  /**
   * @param tabs - the tab-type registry consulted to claim an address.
   * @param pin - `ctx.resources.pin`, which the Tab domain holds addresses with.
   * @param adopted - plugin-owned session stores used by occurrence actions.
   * @param openTabs - plugin-owned metadata source across saved and adopted layouts.
   */
  constructor(
    private readonly tabs: SidebarRightTabRegistry,
    pin: PinResource,
    private readonly adopted = new Map<SessionId, Adoption>(),
    openTabs: SidebarTabInventory['source'] = new SidebarTabInventory().source,
    private readonly retainPinned?: (sessionId: SessionId, tabId: TabId, pinned: boolean) => void,
  ) {
    this.openTabs = openTabs
    this.tabDomain = new TabDomain(this, pin)
  }

  /**
   * Read the committed tabs of a Session so providers can restore their content.
   * @param sessionId - Session whose layout has been adopted.
   * @returns its open records, or an empty list before adoption.
   */
  tabsIn(sessionId: SessionId): readonly TabRecord[] {
    return Object.values(this.adopted.get(sessionId)?.store.getSnapshot().bySession[sessionId]?.layout.tabs ?? {})
  }

  /**
   * Adopt the mounted seat's binding, replacing any previous one.
   *
   * Called from the seat while it is mounted, and released when it leaves.
   * @param binding - the mounted seat's session, actions, and the store's surfaces.
   * @returns a release callback that clears exactly this binding.
   */
  bind(binding: SidebarRightBinding): () => void {
    this.binding = binding
    this.publishMounted()
    return () => {
      // A newer seat may already have taken over; only the binding that is
      // still ours may be cleared.
      if (this.binding !== binding) return
      this.binding = undefined
      this.publishMounted()
    }
  }

  /** Publish the mounted session only when it changes; a republished binding for the same session is silent. */
  private publishMounted(): void {
    const next = this.binding?.sessionId
    if (this.mountedSession.getSnapshot() !== next) this.mountedSession.set(next)
  }

  /**
   * Open a resource: claim it, place it, reveal the column, record the navigation.
   * @param address - a `dsh-resource://<type>/…` address.
   * @param options - placement, the opening type, and navigation parameters.
   */
  openResource(address: string, options: SidebarRightOpenResourceOptions = {}): void {
    const { sessionId, actions } = this.require()
    this.placeResource(sessionId, actions, address, options)
  }

  /**
   * Open a page type by kind at the address this package records pages under.
   * @param kind - the page type's kind.
   * @param options - placement and that kind's navigation parameters.
   */
  openTab<K extends string>(kind: K, options: SidebarRightOpenTabOptions<K> = {}): void {
    const { sessionId, actions } = this.require()
    this.placeTab(sessionId, actions, kind, options)
  }

  /**
   * Open a resource in one session, for a tab's own action; nothing happens
   * for a session whose store was never adopted or whose adoption was released.
   * Not part of `ISidebarRight`: the Tab domain's path.
   * @param sessionId - the session the acting tab is in.
   * @param address - a `dsh-resource://<type>/…` address.
   * @param options - placement, the opening type, and navigation parameters.
   */
  openResourceIn(sessionId: SessionId, address: string, options: SidebarRightOpenResourceOptions = {}): void {
    const actions = this.actionsFor(sessionId)
    if (actions !== undefined) this.placeResource(sessionId, actions, address, options)
  }

  /**
   * Open a page type in one session, for a tab's own action; nothing happens
   * for a session whose store was never adopted or whose adoption was released.
   * Not part of `ISidebarRight`: the Tab domain's path.
   * @param sessionId - the session the acting tab is in.
   * @param kind - the page type's kind.
   * @param options - placement and that kind's navigation parameters.
   */
  openTabIn<K extends string>(sessionId: SessionId, kind: K, options: SidebarRightOpenTabOptions<K> = {}): void {
    const actions = this.actionsFor(sessionId)
    if (actions !== undefined) this.placeTab(sessionId, actions, kind, options)
  }

  /**
   * Close a tab of one session, preserving the sole docked guide; nothing happens
   * for a session whose store was never adopted or whose adoption was released.
   * @param sessionId - the session the tab is in.
   * @param tabId - the tab to close.
   */
  closeIn(sessionId: SessionId, tabId: TabId): void {
    const actions = this.actionsFor(sessionId)
    const surface = this.adopted.get(sessionId)?.store.getSnapshot().bySession[sessionId]
    if (actions === undefined || surface === undefined) return
    const tab = surface.layout.tabs[tabId]
    if (tab === undefined || !canCloseTab(surface, tabId)) return
    this.removeAfterCleanup(sessionId, tab, () => { actions.closeTab(sessionId, tabId) })
  }

  private removeAfterCleanup(sessionId: SessionId, tab: TabRecord, commit: () => void): void {
    this.closeHandlers.get(tab.kind)?.(sessionId, tab)
    commit()
  }

  /** Claim a resource and place it in one session; an address outside the scheme or one no type claims throws. */
  private placeResource(
    sessionId: SessionId,
    actions: SurfaceActions,
    address: string,
    options: SidebarRightOpenResourceOptions,
  ): void {
    if (!address.startsWith(RESOURCE_SCHEME)) {
      throw new Error(`sidebarRight: no registered tab type claims "${address}"`)
    }
    this.place(sessionId, actions, this.tabs.claim(address, options.kind), address, options, options.params)
  }

  /** Place a page type in one session at the address pages are recorded under; an unregistered kind throws. */
  private placeTab<K extends string>(
    sessionId: SessionId,
    actions: SurfaceActions,
    kind: K,
    options: SidebarRightOpenTabOptions<K>,
  ): void {
    const definition = this.tabs.get(kind)
    if (definition === undefined) throw new Error(`sidebarRight: no tab type is registered as "${kind}"`)
    const address = definition.multiple === true ? `${pageAddress(kind)}/${randomUUID()}` : pageAddress(kind)
    this.place(sessionId, actions, { kind, contentId: address, title: definition.title(address) }, address, options, options.params)
  }

  /** The steps both opens share: one store intent, and the navigation record for the tab it settles on. */
  private place(
    sessionId: SessionId,
    actions: SurfaceActions,
    claim: SidebarRightTabClaim,
    address: string,
    placement: SidebarRightPlacement,
    params: SidebarRightNavigationParams,
  ): void {
    const surface = this.adopted.get(sessionId)?.store.getSnapshot().bySession[sessionId]
      ?? (this.binding?.sessionId === sessionId ? this.binding.surfaces[sessionId] : undefined)
    const targetPane = surface === undefined ? undefined : placement.paneId ?? activeDockPaneId(surface.layout)
    const target = targetPane === undefined ? undefined : surface?.layout.nodes[targetPane]
    const preferNewPane = placement.preferNewPane === true
      && placement.replaceTab === undefined
      && surface !== undefined
      && target?.kind === 'pane'
      && target.host === 'dock'
      && target.tabs.length > 0
      && splitAllowed(surface.layout, 'row')
      && this.binding?.sessionId === sessionId
      && this.binding.canSplitPane(target.id, 'row')
    const commit = (): void => { actions.openContent(sessionId, {
      kind: claim.kind,
      contentId: claim.contentId,
      title: claim.title,
      ...placement.paneId === undefined ? {} : { paneId: placement.paneId },
      ...preferNewPane ? { preferNewPane: true } : {},
      ...placement.replaceTab === undefined ? {} : { replaceTab: placement.replaceTab },
      ...placement.revealIfOpened === undefined ? {} : { revealIfOpened: placement.revealIfOpened },
    }, (tabId) => { this.tabDomain.navigate(sessionId, tabId, { address, params }) }) }
    const layout = surface?.layout
    const replaced = placement.replaceTab === undefined ? undefined : layout?.tabs[placement.replaceTab]
    const revealed = layout === undefined || placement.revealIfOpened === false
      ? undefined : findContentTab(layout, claim.contentId, claim.kind)
    if (replaced === undefined || replaced.id === revealed) { commit(); return }
    this.removeAfterCleanup(sessionId, replaced, commit)
  }

  /** Copy a tab into the visible Session; the source Session remains untouched. */
  copyToMounted(tab: Pick<TabRecord, 'kind' | 'contentId' | 'title'>): TabId {
    const { sessionId, actions } = this.require()
    let copied: TabId | undefined
    actions.openContent(sessionId, { ...tab, revealIfOpened: true }, (id) => { copied = id })
    if (copied === undefined) throw new Error('sidebarRight: copy did not create a tab')
    this.tabDomain.navigate(sessionId, copied, { address: tab.contentId, params: undefined })
    return copied
  }

  /** Keep detached tabs mounted while locked, without changing their Session ownership. */
  setPinned(sessionId: SessionId, tabId: TabId, pinned: boolean): void {
    const key = `${sessionId}:${tabId}`
    if (this.pinned.has(key) === pinned) return
    if (pinned) this.pinned.add(key)
    else this.pinned.delete(key)
    const opened = this.windows.get(key)
    if (!pinned && opened !== undefined && sessionId !== this.activeSession) this.parkWindow(key, opened)
    this.retainPinned?.(sessionId, tabId, pinned)
  }

  /**
   * Close one tab of the mounted session; the sole docked guide remains open.
   * @param tabId - the tab to close.
   */
  close(tabId: TabId): void {
    const { sessionId, actions } = this.require()
    if (this.adopted.has(sessionId)) { this.closeIn(sessionId, tabId); return }
    actions.closeTab(sessionId, tabId)
  }

  /**
   * The active tab of the active pane.
   * @returns the record, or `undefined` with no mounted surface.
   */
  active(): TabRecord | undefined {
    const layout = this.mountedSurface()?.layout
    if (layout === undefined) return undefined
    const { activeTabId } = getPane(layout, layout.activePaneId)
    return Object.values(layout.tabs).find(tab => tab.id === activeTabId)
  }

  /**
   * Whether the column is currently showing its panel.
   * @returns `true` while expanded; `false` while collapsed or with no mounted surface.
   */
  isExpanded(): boolean {
    return this.mountedSurface()?.layout.expanded ?? false
  }

  /** Collapse the column, or expand it and focus its active dock pane after rendering. */
  toggleExpanded(): void {
    const { sessionId, actions, openWithFocus } = this.require()
    openWithFocus(() => {
      actions.toggleExpanded(sessionId)
      const layout = this.mountedSurface()?.layout
      return layout?.expanded ? activeDockPaneId(layout) : undefined
    })
  }

  /**
   * Focus a tab and the pane holding it; a missing tab is left alone.
   * @param tabId - the tab to focus.
   */
  focus(tabId: TabId): void {
    const { sessionId, actions } = this.require()
    if (this.mountedSurface()?.layout.tabs[tabId] === undefined) return
    actions.focusTab(sessionId, tabId)
  }

  /**
   * Capture the page owning current DOM focus; outside focus never uses layout history.
   * @param element - explicit input target, including an embedding iframe; defaults to live document focus.
   * @returns current focused page identity, or undefined outside a visible sidebar page.
   */
  focusedTarget(element: Element | null = document.activeElement): SidebarRightTarget | undefined {
    const binding = this.binding
    const surface = this.mountedSurface()
    return binding === undefined || surface === undefined ? undefined
      : sidebarTargetFromElement(element, binding.sessionId, surface.layout,
        tabId => this.tabDomain.occurrence(binding.sessionId, { id: tabId }))
  }

  /**
   * Choose a focused sidebar pane, or the mounted Session's active dock pane for an outside open.
   * @param element - live command input target; stale sidebar markup never falls back to another pane.
   * @returns captured target, or undefined without a mounted Session.
   */
  commandTarget(element: Element | null = document.activeElement): SidebarRightTarget | undefined {
    const focused = this.focusedTarget(element)
    if (focused !== undefined || element?.closest('[data-sidebar-right-session]')) return focused
    const binding = this.binding
    const layout = this.mountedSurface()?.layout
    if (binding === undefined || layout === undefined) return undefined
    const pane = getPane(layout, activeDockPaneId(layout))
    const tabId = pane.activeTabId
    const held = tabId === undefined ? undefined : this.tabDomain.occurrence(binding.sessionId, { id: tabId })
    return { sessionId: binding.sessionId, paneId: pane.id, host: pane.host, tabId,
      occurrence: held, navigationRevision: held?.navigation.getSnapshot().revision }
  }

  /**
   * Open from a captured pane using the guide's replacement and floating placement rules.
   * @param kind - registered page kind.
   * @param target - captured live pane and optional page.
   */
  openTabFromTarget(kind: string, target: SidebarRightTarget): void {
    if (!this.isTargetCurrent(target)) return
    this.require().openWithFocus(() => {
      const tab = target.tabId === undefined ? undefined : this.mountedSurface()?.layout.tabs[target.tabId]
      if (target.host === 'float' && tab?.kind === kind && this.tabs.get(kind)?.multiple !== true) {
        this.require().actions.setExpanded(target.sessionId, true)
        this.focus(tab.id)
      } else {
        this.openTab(kind, {
          ...target.host === 'dock' ? { paneId: target.paneId } : {},
          ...tab?.kind === 'guide' ? { replaceTab: tab.id } : {},
        })
      }
      return this.mountedSurface()?.layout.activePaneId
    })
  }

  /**
   * Test explicit close eligibility without using the last selected page.
   * @param target - captured focused page.
   * @returns whether this current page can be removed or its sole guide pane collapsed.
   */
  canCloseTarget(target: SidebarRightTarget): boolean {
    return this.isTargetCurrent(target) && target.tabId !== undefined
  }

  /**
   * Remove a captured page through its resource cleanup handler, or collapse the sole docked guide.
   * Cleanup errors propagate and preserve the page.
   * @param target - page captured while resolving the command.
   * @returns closed after removal or collapse, unavailable without a page, or stale after identity changes.
   */
  closeTarget(target: SidebarRightTarget): 'closed' | 'unavailable' | 'stale' {
    if (!this.isTargetCurrent(target)) return 'stale'
    const surface = this.mountedSurface()
    if (surface === undefined || target.tabId === undefined) return 'unavailable'
    const tabId = target.tabId
    const binding = this.require()
    binding.closeWithFocus(target.paneId, () => {
      if (canCloseTab(surface, tabId)) this.close(tabId)
      else binding.actions.setExpanded(target.sessionId, false)
    })
    return 'closed'
  }

  /**
   * Check a captured target before acting, including reopened records and intervening navigation.
   * @param target - identity captured while resolving the input.
   * @returns whether the mounted Session, pane, tab lifetime and navigation still match.
   */
  isTargetCurrent(target: SidebarRightTarget): boolean {
    if (this.binding?.sessionId !== target.sessionId) return false
    const layout = this.mountedSurface()?.layout
    const pane = layout?.nodes[target.paneId]
    if (pane?.kind !== 'pane' || pane.host !== target.host) return false
    if (target.tabId === undefined) return pane.activeTabId === undefined
    if (!pane.tabs.includes(target.tabId) || layout?.tabs[target.tabId] === undefined) return false
    const held = this.tabDomain.occurrence(target.sessionId, { id: target.tabId })
    return held === target.occurrence && !held.signal.aborted
      && held.navigation.getSnapshot().revision === target.navigationRevision
  }

  /**
   * Explain the same geometry and pane-budget rule used by the split control.
   * @param target - captured command or button target.
   * @returns a localizable block discriminator, or undefined when splitting is available.
   */
  splitBlock(target: SidebarRightTarget): 'stale' | 'collapsed' | 'float' | 'empty' | 'budget' | 'width' | undefined {
    const surface = this.mountedSurface()
    if (surface === undefined || !this.isTargetCurrent(target)) return 'stale'
    const { layout } = surface
    if (target.host === 'float') return 'float'
    if (!layout.expanded) return 'collapsed'
    if (getPane(layout, target.paneId).tabs.length === 0) return 'empty'
    if (!splitAllowed(layout, 'row')) return 'budget'
    if (!this.require().canSplitPane(target.paneId, 'row')) return 'width'
    return undefined
  }

  /**
   * Toggle the right panel's display mode through the same action as its chrome button.
   * @param target - captured dock pane; floating and stale targets are unchanged.
   */
  toggleFullscreen(target: SidebarRightTarget): void {
    if (!this.isTargetCurrent(target) || target.host === 'float' || !this.isExpanded()) return
    const { sessionId, actions, autoFullscreen } = this.require()
    const fullscreen = autoFullscreen === true || this.mountedSurface()?.layout.mode === 'fullscreen'
    if (fullscreen && autoFullscreen === true) actions.setExpanded(sessionId, false)
    actions.setMode(sessionId, fullscreen ? 'push' : 'fullscreen')
  }

  /**
   * Split a docked pane to its right when the budget and the room rule allow.
   * @param paneId - the pane to split; defaults to the active docked pane.
   * @returns the new pane's id, or `undefined` when nothing was split.
   */
  split(paneId?: PaneId, axis: SplitAxis = 'row'): PaneId | undefined {
    const { sessionId, actions, canSplitPane } = this.require()
    const layout = this.mountedSurface()?.layout
    if (layout === undefined) return undefined
    const target = paneId ?? activeDockPaneId(layout)
    const node = layout.nodes[target]
    if (node === undefined || node.kind !== 'pane' || node.host !== 'dock') return undefined
    if (!splitAllowed(layout, axis) || !canSplitPane(target, axis)) return undefined
    let created: PaneId | undefined
    this.require().openWithFocus(() => {
      actions.splitPane(sessionId, target, (id) => { created = id }, axis)
      return created
    })
    return created
  }

  /**
   * Take a docked tab out into a floating panel; a missing or floating tab is left alone.
   * @param tabId - the tab to float.
   * @param rect - the panel's rectangle; defaults to the cascade from the last panel.
   */
  float(tabId: TabId, rect?: FloatRect): void {
    const { sessionId, actions } = this.require()
    const layout = this.mountedSurface()?.layout
    if (layout === undefined || layout.tabs[tabId] === undefined) return
    if (findTabPane(layout, tabId).host !== 'dock') return
    actions.floatTab(sessionId, tabId, rect)
  }

  /**
   * Return a floating panel's tab to the active docked pane; a missing or docked pane is left alone.
   * @param paneId - the floating pane.
   */
  dock(paneId: PaneId): void {
    const { sessionId, actions } = this.require()
    const node = this.mountedSurface()?.layout.nodes[paneId]
    if (node === undefined || node.kind !== 'pane' || node.host !== 'float') return
    actions.unfloatPane(sessionId, paneId)
  }

  registerWindowOpener(open: (tab: TabRecord, bounds?: FloatRect) => Window | null): () => void {
    if (this.windowOpener !== undefined) throw new Error('sidebarRight: window opener already registered')
    this.windowOpener = open
    this.resumeSession = this.activeSession
    if (this.activeSession !== undefined) this.resumeWindows(this.activeSession)
    const closeAll = (): void => {
      for (const key of [...this.windows.keys()]) this.releaseWindow(key, true, true)
    }
    window.addEventListener('pagehide', closeAll)
    return () => {
      if (this.windowOpener !== open) return
      this.windowOpener = undefined
      window.removeEventListener('pagehide', closeAll)
      closeAll()
    }
  }

  /** Close inactive session windows without docking their tabs; reopen on selection. */
  activateWindows(sessionId: SessionId | undefined): void {
    if (this.activeSession === sessionId) return
    for (const [key, opened] of [...this.windows]) {
      if (opened.window.closed) { this.closedWindow(opened); continue }
      if (this.pinned.has(key)) continue
      this.parkWindow(key, opened)
    }
    this.activeSession = sessionId
    this.resumeSession = sessionId
    if (sessionId !== undefined) this.resumeWindows(sessionId)
  }

  private parkWindow(key: string, opened: Satellite): void {
    const { screenX, screenY, outerWidth, outerHeight } = opened.window
    this.parked.set(key, { sessionId: opened.sessionId, tabId: opened.tabId, paneId: opened.paneId,
      bounds: { x: Number.isFinite(screenX) ? screenX : 0, y: Number.isFinite(screenY) ? screenY : 0,
        width: outerWidth > 0 ? outerWidth : 900, height: outerHeight > 0 ? outerHeight : 700 } })
    this.releaseWindow(key)
  }

  /** Retry only once per selection; browsers may refuse automatic popups. */
  resumeWindows(sessionId: SessionId): void {
    if (this.resumeSession !== sessionId || this.windowOpener === undefined) return
    const layout = this.adopted.get(sessionId)?.store.getSnapshot().bySession[sessionId]?.layout
    if (layout === undefined) return
    this.resumeSession = undefined
    for (const [key, parked] of [...this.parked]) {
      if (parked.sessionId !== sessionId) continue
      const tab = layout.tabs[parked.tabId]
      if (tab === undefined) { this.parked.delete(key); this.publishWindows(); continue }
      try {
        const popup = this.windowOpener(tab, parked.bounds)
        if (popup !== null && this.attachWindow(sessionId, tab.id, parked.paneId, popup)) {
          continue
        }
      } catch (error) {
        console.warn('sidebarRight: detached window could not be restored', parked.tabId, error)
        continue
      }
      console.warn('sidebarRight: browser blocked restoring a detached tab window', parked.tabId)
    }
  }

  /** A satellite renders the original React tab: it never owns a second layout writer. */
  popout(tabId: TabId, rect?: FloatRect): boolean {
    const { sessionId, actions } = this.require()
    const layout = this.mountedSurface()?.layout
    const tab = layout?.tabs[tabId]
    const open = this.windowOpener
    if (layout === undefined || tab === undefined || open === undefined) return false
    const key = `${sessionId}:${tabId}`
    if (this.windows.has(key)) { this.windows.get(key)?.window.focus(); return true }
    const popup = open(tab, this.parked.get(key)?.bounds)
    if (popup === null) return false
    try {
      if (findTabPane(layout, tabId).host === 'dock') actions.floatTab(sessionId, tabId, rect)
      const updated = this.adopted.get(sessionId)?.store.getSnapshot().bySession[sessionId]?.layout
      const pane = updated === undefined ? undefined : findTabPane(updated, tabId)
      if (pane?.host !== 'float' || !this.attachWindow(sessionId, tabId, pane.id, popup)) {
        popup.close()
        return false
      }
      return true
    } catch (error) {
      popup.close()
      throw error
    }
  }

  private attachWindow(sessionId: SessionId, tabId: TabId, paneId: PaneId, popup: Window): boolean {
    let target: HTMLElement
    try { target = popup.document.body }
    catch { popup.close(); return false }
    if (target === null) { popup.close(); return false }
    const opened: Satellite = { window: popup, target, sessionId, tabId, paneId, stop: () => {} }
    const onClose = (): void => { this.closedWindow(opened) }
    popup.addEventListener('pagehide', onClose)
    const interval = window.setInterval(() => { if (popup.closed) onClose() }, 1000)
    opened.stop = () => { popup.removeEventListener('pagehide', onClose); window.clearInterval(interval) }
    const key = `${sessionId}:${tabId}`
    this.windows.set(key, opened)
    this.parked.delete(key)
    this.publishWindows()
    return true
  }

  /** Native window closure is a tab close, unlike explicit docking or session-switch parking. */
  private closedWindow(opened: Satellite): void {
    const key = `${opened.sessionId}:${opened.tabId}`
    if (this.windows.get(key) !== opened) return
    this.releaseWindow(key, false)
    try { this.closeIn(opened.sessionId, opened.tabId) }
    catch (error) { console.error('Sidebar tab close failed:', error) }
  }

  /** Follow a floating pane through tab replacement; release it when the pane docks or closes. */
  reconcileWindows(sessionId: SessionId, layout: LayoutState): void {
    for (const [key, opened] of [...this.windows]) {
      if (opened.sessionId !== sessionId) continue
      const pane = layout.nodes[opened.paneId]
      const tabId = pane?.kind === 'pane' && pane.host === 'float' ? pane.tabs[0] : undefined
      const tab = tabId === undefined ? undefined : layout.tabs[tabId]
      if (tabId === undefined || tab === undefined) { this.releaseWindow(key); continue }
      if (tabId !== opened.tabId) {
        this.windows.delete(key)
        opened.tabId = tabId
        this.windows.set(`${sessionId}:${tabId}`, opened)
        try { opened.window.document.title = `${tab.title} — DSH` } catch { /* window closed concurrently */ }
        this.publishWindows()
      }
    }
    let changed = false
    for (const [key, parked] of [...this.parked]) {
      if (parked.sessionId !== sessionId) continue
      const pane = layout.nodes[parked.paneId]
      const tabId = pane?.kind === 'pane' && pane.host === 'float' ? pane.tabs[0] : undefined
      if (tabId === undefined || layout.tabs[tabId] === undefined) {
        this.parked.delete(key)
        changed = true
        continue
      }
      if (tabId !== parked.tabId) {
        this.parked.delete(key)
        this.parked.set(`${sessionId}:${tabId}`, { ...parked, tabId })
        changed = true
      }
    }
    if (changed) this.publishWindows()
  }

  private publishWindows(): void {
    const targets = new Map<string, HTMLElement | undefined>([...this.parked.keys()].map(key => [key, undefined]))
    for (const [key, opened] of this.windows) targets.set(key, opened.target)
    this.popouts.set(targets)
  }

  private releaseWindow(key: string, close = true, immediately = false): void {
    const opened = this.windows.get(key)
    if (opened === undefined) return
    this.windows.delete(key)
    opened.stop()
    this.publishWindows()
    if (!close || opened.window.closed) return
    const content = opened.target.querySelector('[data-dockkit-content]')
    if (immediately || content === null) { opened.window.close(); return }
    const observer = new MutationObserver(() => {
      if (opened.target.contains(content)) return
      observer.disconnect()
      window.removeEventListener('pagehide', finish)
      if (!opened.window.closed) opened.window.close()
    })
    const finish = (): void => {
      observer.disconnect()
      if (!opened.window.closed) opened.window.close()
    }
    // Closing before React moves its mount would destroy the tab's live DOM.
    observer.observe(opened.target, { childList: true, subtree: true })
    window.addEventListener('pagehide', finish, { once: true })
  }

  /**
   * Step the mounted session's surface back one intent.
   *
   * @internal Not part of the product: the sequence is an architectural fact
   * with no user-facing control yet. Kept reachable for tests.
   */
  _undo(): void {
    const { sessionId, actions } = this.require()
    actions.undo(sessionId)
  }

  /**
   * Step the mounted session's surface forward one intent.
   *
   * @internal See `_undo`.
   */
  _redo(): void {
    const { sessionId, actions } = this.require()
    actions.redo(sessionId)
  }

  /** The mounted session's surface; `undefined` without a seat or before its first open. */
  private mountedSurface(): SurfaceState | undefined {
    const { binding } = this
    return binding === undefined ? undefined
      : this.adopted.get(binding.sessionId)?.store.getSnapshot().bySession[binding.sessionId] ?? binding.surfaces[binding.sessionId]
  }

  /**
   * The store actions a tab's own action on `sessionId` runs through: that
   * session's adopted store. `undefined` — nothing to act on — for a session
   * whose store was never minted or whose adoption was released.
   */
  private actionsFor(sessionId: SessionId): SurfaceActions | undefined {
    return this.adopted.get(sessionId)?.store.actions
  }

  private require(): SidebarRightBinding {
    // Reads answer for the no-session case (there is nothing expanded), but a
    // write has no session to write to. Callers are UI gestures and tool
    // results, both of which belong to a session that is on screen.
    if (this.binding === undefined) {
      throw new Error('sidebarRight: no session surface is mounted')
    }
    return this.binding
  }
}
