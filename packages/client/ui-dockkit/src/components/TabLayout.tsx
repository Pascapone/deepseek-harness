/** Stable tab siblings over a recursive split tree, including viewport-positioned floats. */
import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, MutableRefObject, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { PortalDocument } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DockIntents } from '../contract/adapter.ts'
import type { LayoutState, NodeId, PaneId, PaneNode, SplitNode, TabId, TabRecord } from '../contract/types.ts'
import { findTabPane, floatRect, getNode, getPane } from '../engine/tree.ts'
import type { SizePreview } from './PaneTree.tsx'
import type { PaneCallbacks } from './render.ts'
import { FloatHeader, useFloatGestures } from './FloatLayer.tsx'
import { PaneDropHints, TabPanel, TabStrip } from './TabPanel.tsx'
import css from './dockkit.module.css'

/** Host policy for lazily retaining a tab body without reparenting it. */
export interface TabRetention {
  /** Whether a visited docked body survives hiding; floated bodies remain retained until closed. */
  readonly keepMounted?: (tab: TabRecord) => boolean
  /** Whether this layout's Session is on screen; defaults to true. */
  readonly active?: boolean
  /** Externally owned destinations for complete floating panes. */
  readonly externalPaneTargets?: ReadonlyMap<PaneId, HTMLElement>
  /** Called after a withdrawn destination's pane DOM returns to the native document. */
  readonly onExternalPaneReleased?: (paneId: PaneId, target: HTMLElement) => void
  /** Current pane chrome element, including elements in external documents. */
  readonly onPaneElement?: (paneId: PaneId, element: HTMLElement | null) => void
}

interface LayoutProps extends TabRetention {
  readonly state: LayoutState
  readonly callbacks: PaneCallbacks
  readonly preview: SizePreview | undefined
  readonly intents: DockIntents
}

interface Bounds { readonly left: number; readonly top: number; readonly width: number; readonly height: number }

function boundsStyle(box: Bounds): CSSProperties {
  return { left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` }
}

/** Moving mounted content preserves the focused editor. */
function attachMount(target: HTMLElement | null | undefined, mount: HTMLElement, savedFocus?: HTMLElement): void {
  if (target === undefined || target === null || mount.parentNode === target) return
  const focused = mount.ownerDocument.activeElement
  const restore = savedFocus ?? (focused?.nodeType === 1 && mount.contains(focused) ? focused as HTMLElement : undefined)
  target.append(mount)
  if (restore?.isConnected) restore.focus({ preventScroll: true })
}

interface TabHostProps extends LayoutProps {
  readonly floatBody: HTMLElement | undefined
  readonly tab: TabRecord
  readonly pane: PaneNode
  readonly position: Bounds
  readonly floats: ReturnType<typeof useFloatGestures>
  readonly focusRequest: MutableRefObject<{ readonly tabId: TabId; readonly origin: Element | null } | undefined>
}

/** A tab's ancestors stay identical across selection, pane moves and floating. */
function TabHost({ state, callbacks, tab, pane, position, floats, focusRequest, keepMounted,
  active = true, floatBody, onPaneElement, externalPaneTargets }: TabHostProps): ReactNode {
  const floating = pane.host === 'float'
  const selected = pane.activeTabId === tab.id
  const visible = active && selected && (floating || state.expanded)
  const floated = useRef(floating)
  if (floating) floated.current = true
  const retained = floated.current || (keepMounted?.(tab) ?? false)
  const [visited, setVisited] = useState(visible)
  if (visible && !visited) setVisited(true)
  const host = useRef<HTMLElement | null>(null)
  const body = useRef<HTMLDivElement | null>(null)
  const cell = useRef<HTMLDivElement | null>(null)
  const [mount] = useState(() => {
    const element = document.createElement('div')
    element.style.display = 'contents'
    return element
  })
  const target = floating ? floatBody : undefined
  const portalDocument = floating ? externalPaneTargets?.get(pane.id)?.ownerDocument ?? document : document
  const focused = mount.ownerDocument.activeElement
  const savedFocus = focused?.nodeType === 1 && mount.contains(focused) ? focused as HTMLElement : undefined
  useLayoutEffect(() => {
    attachMount(target ?? cell.current, mount, savedFocus)
  }, [target, mount, savedFocus])
  useLayoutEffect(() => () => { mount.remove() }, [mount])
  useLayoutEffect(() => {
    // Both refs target unconditional descendants attached before these effects.
    const section = host.current as HTMLElement
    section.inert = !visible
    const focused = section.ownerDocument.activeElement
    if (!visible && focused?.nodeType === 1 && section.contains(focused)) (focused as HTMLElement).blur()
    const request = focusRequest.current
    if (!visible || request?.tabId !== tab.id) return
    focusRequest.current = undefined
    // Preserve deliberate focus taken by another control or the newly shown body.
    const doc = section.ownerDocument
    if (focused !== null && focused !== doc.body && focused !== doc.documentElement && focused !== request.origin) return
    const strip = section.querySelector('[data-dockkit-strip]') ?? section.closest('[data-dockkit-pane]')?.querySelector('[data-dockkit-strip]')
    const chip = [...strip?.querySelectorAll<HTMLElement>('[data-dockkit-tab]') ?? []]
      .find(element => element.dataset.dockkitTab === tab.id)
    chip?.focus({ preventScroll: true })
  }, [visible, tab.id, focusRequest])
  // Electron emits a non-bubbling focus event on the webview element.
  useLayoutEffect(() => {
    const element = body.current as HTMLDivElement
    const focus = (): void => {
      if (!visible) return
      if (floating) floats.raise(pane.id)
      else if (state.activePaneId !== pane.id) callbacks.onFocusPane(pane.id)
    }
    element.addEventListener('focus', focus, true)
    return () => { element.removeEventListener('focus', focus, true) }
  }, [visible, floating, floats, pane.id, state.activePaneId, callbacks])
  useLayoutEffect(() => {
    if (floating || !selected) return
    onPaneElement?.(pane.id, host.current)
    return () => { onPaneElement?.(pane.id, null) }
  }, [floating, selected, pane.id, onPaneElement])
  return (
    <div className={clsx(css.tabCell, floating && css.floatingCell)} hidden={!selected}
      ref={(element) => { cell.current = element; if (element !== null && mount.parentNode === null) element.append(mount) }}
      data-dockkit-host={floating ? 'float' : 'dock'} data-dockkit-column={floating ? undefined : position.left === 0 ? 0 : 1}
      style={floating ? { left: 0, top: 0, width: 0, height: 0, zIndex: 0 } : boundsStyle(position)}>
      {createPortal(<PortalDocument.Provider value={portalDocument}>
        <section ref={host} tabIndex={-1} className={clsx(css.tabHost, floating ? css.floatTabBody : css.pane)} hidden={!selected}
          aria-hidden={!visible || undefined}
          data-dockkit-content={tab.id}
          data-dockkit-pane={!floating && selected ? pane.id : undefined}
          data-dockkit-pane-active={!floating && state.activePaneId === pane.id || undefined}
          data-dockkit-float-tab={floating ? pane.id : undefined}
          data-dockkit-float-active={floating && state.activePaneId === pane.id || undefined}
          data-dockkit-column={!floating ? position.left === 0 ? 0 : 1 : undefined}
          onPointerDown={() => { if (floating) floats.raise(pane.id) }}
          onClick={() => { if (!floating && state.activePaneId !== pane.id) callbacks.onFocusPane(pane.id) }}>
          <div className={css.tabHostHeader}>
            {selected && !floating && <TabStrip state={state} pane={pane} callbacks={callbacks} />}
          </div>
          <div ref={body} className={clsx(css.tabHostBody, floating ? css.floatBody : css.paneBody)}>
            {visited && (retained || (active && selected)) ? callbacks.renderTab(tab) : null}
            {!floating && <PaneDropHints pane={pane} callbacks={callbacks} />}
          </div>

        </section></PortalDocument.Provider>, mount)}
    </div>
  )
}

interface FloatPaneProps extends LayoutProps {
  readonly pane: PaneNode
  readonly bodyElement: HTMLElement
  readonly floats: ReturnType<typeof useFloatGestures>
}

/** A pane owns one chrome and moves its persistent DOM mount as a unit. */
function FloatingPane({ state, pane, callbacks, intents, bodyElement, floats, externalPaneTargets,
  onExternalPaneReleased, onPaneElement, active = true }: FloatPaneProps): ReactNode {
  const cell = useRef<HTMLDivElement | null>(null)
  const shell = useRef<HTMLElement | null>(null)
  const [mount] = useState(() => document.createElement('div'))
  const previousTarget = useRef<HTMLElement>()
  const release = useRef(onExternalPaneReleased)
  release.current = onExternalPaneReleased
  const target = externalPaneTargets?.get(pane.id)
  const focused = bodyElement.ownerDocument.activeElement
  const focusedTab = focused?.closest<HTMLElement>('[data-dockkit-content]')?.dataset.dockkitContent
  const savedFocus = focused?.nodeType === 1 && pane.tabs.some(id => id === focusedTab) ? focused as HTMLElement : undefined
  useLayoutEffect(() => {
    const previous = previousTarget.current
    attachMount(target ?? cell.current, mount, savedFocus)
    previousTarget.current = target
    if (previous !== undefined && previous !== target) onExternalPaneReleased?.(pane.id, previous)
  }, [target, mount, pane.id, onExternalPaneReleased, savedFocus])
  useLayoutEffect(() => {
    onPaneElement?.(pane.id, shell.current)
    return () => { onPaneElement?.(pane.id, null) }
  }, [pane.id, onPaneElement, target])
  useLayoutEffect(() => () => {
    mount.remove()
    const target = previousTarget.current
    if (target !== undefined) queueMicrotask(() => { release.current?.(pane.id, target) })
  }, [mount, pane.id])
  const lifted = floats.preview?.paneId === pane.id ? floats.preview.rect : undefined
  const rect = lifted ?? floatRect(pane)
  const depth = lifted === undefined ? state.floats.indexOf(pane.id) + 1 : state.floats.length + 1
  const tab = pane.activeTabId === undefined ? undefined : state.tabs[pane.activeTabId]
  return <div ref={cell} className={css.floatingCell}>
    {createPortal(<PortalDocument.Provider value={target?.ownerDocument ?? document}>
      <section ref={shell} className={css.float} data-dockkit-float={pane.id} data-dockkit-pane={pane.id}
        data-dockkit-pane-active={state.activePaneId === pane.id || undefined}
        data-dockkit-float-active={state.activePaneId === pane.id || undefined} tabIndex={-1} hidden={!active}
        style={{ left: rect.x, top: `max(var(--dsh-dockkit-float-top, 0px), ${rect.y}px)`, width: rect.width,
          height: rect.height, zIndex: `calc(var(--dsh-dockkit-float-layer, 60) + ${depth})` }}
        onPointerDown={() => { floats.raise(pane.id) }}>
        {tab !== undefined && <FloatHeader paneId={pane.id} tab={tab} labels={callbacks.labels} intents={intents}
          renderTabTitle={callbacks.renderTabTitle} canCloseTab={callbacks.canCloseTab} drag={floats.drag}
          movable={target === undefined} tabIds={pane.tabs}><TabStrip state={state} pane={pane} callbacks={callbacks} /></FloatHeader>}
        <div className={css.floatBody} ref={(element) => { if (element !== null) attachMount(element, bodyElement) }} />
        {target === undefined && <div className={css.floatResize} data-dockkit-float-resize={pane.id}
          onPointerDown={(event) => { floats.drag('resize', pane.id, event) }} />}
      </section>
    </PortalDocument.Provider>, mount)}
  </div>
}

/**
 * Stable tab siblings positioned from the split tree at any depth.
 * @param props - committed layout, gesture preview and body retention policy.
 * @returns stable tab containers, including floating tabs.
 */
export function TabLayout(props: LayoutProps): ReactNode {
  const { state, callbacks, preview } = props
  const [floatBodies] = useState(() => new Map<PaneId, HTMLElement>())
  for (const paneId of state.floats) {
    if (!floatBodies.has(paneId)) {
      const body = document.createElement('div')
      body.style.display = 'contents'
      floatBodies.set(paneId, body)
    }
  }
  useLayoutEffect(() => {
    for (const id of floatBodies.keys()) if (!state.floats.includes(id)) floatBodies.delete(id)
  }, [state.floats, floatBodies])
  const focusRequest = useRef<{ readonly tabId: TabId; readonly origin: Element | null }>()
  const tabCallbacks: PaneCallbacks = {
    ...callbacks,
    onFocusTab: (tabId) => {
      // Docked strips change owner with the selected body; floating strips remain pane-owned.
      const pane = findTabPane(state, tabId)
      const doc = floatBodies.get(pane.id)?.ownerDocument ?? document
      focusRequest.current = pane.activeTabId === tabId ? undefined : { tabId, origin: doc.activeElement }
      callbacks.onFocusTab(tabId)
    },
  }
  const positions = new Map<PaneId, Bounds>()
  const dividers: { split: SplitNode; box: Bounds; offsets: number[] }[] = []
  const walk = (id: NodeId, box: Bounds): void => {
    const node = getNode(state, id)
    if (node.kind === 'pane') { positions.set(node.id, box); return }
    const sizes = preview?.splitId === node.id ? preview.sizes : node.sizes
    const offsets: number[] = []
    let offset = 0
    node.children.forEach((child, index) => {
      const size = sizes[index]
      if (size === undefined) throw new Error('Missing split size')
      walk(child, node.axis === 'row'
        ? { ...box, left: box.left + box.width * offset, width: box.width * size }
        : { ...box, top: box.top + box.height * offset, height: box.height * size })
      offset += size
      if (index < node.children.length - 1) offsets.push(offset * 100)
    })
    dividers.push({ split: node, box, offsets })
  }
  walk(state.rootId, { left: 0, top: 0, width: 100, height: 100 })
  const panes = [...positions.keys()].map(id => getPane(state, id))
  const floats = useFloatGestures(state, props.intents)
  return (
    <div className={css.tabLayout}>
      {/* Logical order changes must not make React move a connected webview's ancestor. */}
      {Object.values(state.tabs).sort((a, b) => a.id.localeCompare(b.id)).map((tab) => {
        const pane = findTabPane(state, tab.id)
        return <TabHost key={tab.id} {...props} callbacks={tabCallbacks} tab={tab} pane={pane}
          position={positions.get(pane.id) ?? { left: 0, top: 0, width: 100, height: 100 }}
          floats={floats} focusRequest={focusRequest} floatBody={floatBodies.get(pane.id)} />
      })}
      {[...state.floats].sort((a, b) => a.localeCompare(b)).map((id) => {
        const bodyElement = floatBodies.get(id)
        if (bodyElement === undefined) throw new Error('Missing floating pane body')
        return <FloatingPane key={id} {...props} callbacks={tabCallbacks} pane={getPane(state, id)}
          bodyElement={bodyElement} floats={floats} />
      })}
      {panes.filter(pane => pane.tabs.length === 0).map((pane) => {
        const position = positions.get(pane.id)
        if (position === undefined) throw new Error('Missing docked pane position')
        return <div key={pane.id} className={css.emptyTabHost} data-dockkit-empty
          style={boundsStyle(position)}>
          <TabPanel state={state} pane={pane} callbacks={callbacks} />
        </div>
      })}
      {dividers.map(({ split, box, offsets }) =>
        <div key={split.id} className={css.tabLayoutSplit} data-dockkit-split={split.id} style={boundsStyle(box)}>
          {offsets.map((offset, index) => <div key={index} className={clsx(css.divider, css.tabLayoutDivider,
            split.axis === 'column' && css.tabLayoutDividerColumn)}
          data-dockkit-divider={`${split.id}:${index}`}
          style={split.axis === 'row' ? { left: `${offset}%`, top: 0, height: '100%' }
            : { left: 0, top: `${offset}%`, width: '100%' }}
          onPointerDown={(event) => { callbacks.onDividerPressed(split.id, index, event) }} />)}
        </div>)}
    </div>
  )
}
