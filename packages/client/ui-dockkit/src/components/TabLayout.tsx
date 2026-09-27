/** Stable tab siblings over a recursive split tree, including viewport-positioned floats. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  /** Whether a visited body survives hiding; omitted means visibility-mounted. */
  readonly keepMounted?: (tab: TabRecord) => boolean
  /** Whether this layout's Session is on screen; defaults to true. */
  readonly active?: boolean
  /** An externally owned window mount for a floating tab. */
  readonly popoutTarget?: (tabId: TabId) => HTMLElement | undefined
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

interface TabHostProps extends LayoutProps {
  readonly tab: TabRecord
  readonly pane: PaneNode
  readonly position: Bounds
  readonly floats: ReturnType<typeof useFloatGestures>
  readonly focusRequest: MutableRefObject<{ readonly tabId: TabId; readonly origin: Element | null } | undefined>
}

/** A tab's ancestors stay identical across selection, pane moves and floating. */
function TabHost({ state, callbacks, intents, tab, pane, position, floats, focusRequest, keepMounted,
  active = true, popoutTarget }: TabHostProps): ReactNode {
  const floating = pane.host === 'float'
  const selected = floating || pane.activeTabId === tab.id
  const visible = active && selected && (floating || state.expanded)
  const retained = keepMounted?.(tab) ?? false
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
  const target = floating ? popoutTarget?.(tab.id) : undefined
  useLayoutEffect(() => {
    (target ?? cell.current)?.append(mount)
  }, [target, mount])
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
    const strip = section.querySelector('[data-dockkit-strip]')
    const chip = [...strip?.querySelectorAll<HTMLElement>('[data-dockkit-tab]') ?? []]
      .find(element => element.dataset.dockkitTab === tab.id)
    chip?.focus({ preventScroll: true })
  }, [visible, tab.id, focusRequest])
  // Electron emits a non-bubbling focus event on the webview element.
  useEffect(() => {
    const element = body.current as HTMLDivElement
    const focus = (): void => {
      if (!visible) return
      if (floating) floats.raise(pane.id)
      else if (state.activePaneId !== pane.id) callbacks.onFocusPane(pane.id)
    }
    element.addEventListener('focus', focus, true)
    return () => { element.removeEventListener('focus', focus, true) }
  }, [visible, floating, floats, pane.id, state.activePaneId, callbacks])
  const lifted = floating && floats.preview?.paneId === pane.id ? floats.preview.rect : undefined
  const rect = floating ? lifted ?? floatRect(pane) : undefined
  const depth = lifted === undefined ? state.floats.indexOf(pane.id) + 1 : state.floats.length + 1
  return (
    <div className={clsx(css.tabCell, floating && css.floatingCell)} hidden={!selected}
      ref={(element) => { cell.current = element; if (element !== null && mount.parentNode === null) element.append(mount) }}
      data-dockkit-host={floating ? 'float' : 'dock'} data-dockkit-column={floating ? undefined : position.left === 0 ? 0 : 1}
      style={floating ? { left: 0, top: 0, width: 0, height: 0, zIndex: `calc(var(--dsh-dockkit-float-layer, 60) + ${depth})` } : boundsStyle(position)}>
      {createPortal(<PortalDocument.Provider value={target?.ownerDocument ?? document}>
        <section ref={host} tabIndex={-1} className={clsx(css.tabHost, floating ? css.float : css.pane)}
          aria-hidden={!visible || undefined}
          data-dockkit-content={tab.id}
          data-dockkit-pane={!floating && selected ? pane.id : undefined}
          data-dockkit-pane-active={!floating && state.activePaneId === pane.id || undefined}
          data-dockkit-float={floating ? pane.id : undefined}
          data-dockkit-float-active={floating && state.activePaneId === pane.id || undefined}
          data-dockkit-column={!floating ? position.left === 0 ? 0 : 1 : undefined}
          style={rect === undefined ? undefined : {
            left: rect.x, top: rect.y, width: rect.width, height: rect.height,
          }}
          onPointerDown={() => { if (floating) floats.raise(pane.id) }}
          onClick={() => { if (!floating && state.activePaneId !== pane.id) callbacks.onFocusPane(pane.id) }}>
          <div className={css.tabHostHeader}>
            {selected && (floating
              ? <FloatHeader paneId={pane.id} tab={tab} labels={callbacks.labels} intents={intents}
                renderTabTitle={callbacks.renderTabTitle} canCloseTab={callbacks.canCloseTab} drag={floats.drag}
                movable={target === undefined} />
              : <TabStrip state={state} pane={pane} callbacks={callbacks} />)}
          </div>
          <div ref={body} className={clsx(css.tabHostBody, floating ? css.floatBody : css.paneBody)}>
            {visited && (retained || (active && selected)) ? callbacks.renderTab(tab) : null}
            {!floating && <PaneDropHints pane={pane} callbacks={callbacks} />}
          </div>
          {floating && target === undefined && <div className={css.floatResize} data-dockkit-float-resize={pane.id}
            onPointerDown={(event) => { floats.drag('resize', pane.id, event) }} />}
        </section></PortalDocument.Provider>, mount)}
    </div>
  )
}

/**
 * Stable tab siblings positioned from the split tree at any depth.
 * @param props - committed layout, gesture preview and body retention policy.
 * @returns stable tab containers, including floating tabs.
 */
export function TabLayout(props: LayoutProps): ReactNode {
  const { state, callbacks, preview } = props
  const focusRequest = useRef<{ readonly tabId: TabId; readonly origin: Element | null }>()
  const tabCallbacks: PaneCallbacks = {
    ...callbacks,
    onFocusTab: (tabId) => {
      // Only changing the selected body replaces its strip; pane-only focus does not.
      focusRequest.current = findTabPane(state, tabId).activeTabId === tabId
        ? undefined : { tabId, origin: document.activeElement }
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
          floats={floats} focusRequest={focusRequest} />
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
