/** Stable tab siblings in one two-axis Grid, including viewport-positioned floats. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MutableRefObject, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { PortalDocument } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DockIntents } from '../contract/adapter.ts'
import type { LayoutState, PaneId, PaneNode, SplitNode, TabId, TabRecord } from '../contract/types.ts'
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

interface TabHostProps extends LayoutProps {
  readonly tab: TabRecord
  readonly pane: PaneNode
  readonly position: { column: number; row: number; columns: number; rows: number }
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
      data-dockkit-host={floating ? 'float' : 'dock'} data-dockkit-column={floating ? undefined : position.column}
      style={{ gridColumn: floating ? 1 : `${position.column * 2 + 1} / span ${position.columns * 2 - 1}`,
        gridRow: floating ? 1 : `${position.row * 2 + 1} / span ${position.rows * 2 - 1}`, order: floating ? depth : 0 }}>
      {createPortal(<PortalDocument.Provider value={target?.ownerDocument ?? document}>
        <section ref={host} tabIndex={-1} className={clsx(css.tabHost, floating ? css.float : css.pane)}
          aria-hidden={!visible || undefined}
          data-dockkit-content={tab.id}
          data-dockkit-pane={!floating && selected ? pane.id : undefined}
          data-dockkit-pane-active={!floating && state.activePaneId === pane.id || undefined}
          data-dockkit-float={floating ? pane.id : undefined}
          data-dockkit-float-active={floating && state.activePaneId === pane.id || undefined}
          data-dockkit-column={!floating ? position.column : undefined}
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
 * Up to three panes with one split per axis; CSS resolves track fractions.
 * @param props - committed layout, gesture preview and body retention policy.
 * @returns stable tab containers, including floating tabs.
 * @throws if the docked tree exceeds the supported split policy.
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
  const root = getNode(state, state.rootId)
  const nestedIndex = root.kind === 'split' ? root.children.findIndex(id => getNode(state, id).kind === 'split') : -1
  const nestedId = root.kind === 'split' ? root.children[nestedIndex] : undefined
  const nestedNode = nestedId === undefined ? undefined : getNode(state, nestedId)
  const nested = nestedNode?.kind === 'split' ? nestedNode : undefined
  if (root.kind === 'split' && (root.children.length !== 2 || (nested !== undefined
    && (nested.children.length !== 2 || nested.axis === root.axis
      || root.children.filter(id => getNode(state, id).kind === 'split').length !== 1)))) {
    throw new Error('DockLayout supports one split per axis')
  }
  const sizes = (split: SplitNode): readonly number[] => preview?.splitId === split.id ? preview.sizes : split.sizes
  const along = (axis: SplitNode['axis']): readonly number[] => root.kind === 'split' && root.axis === axis
    ? sizes(root) : nested?.axis === axis ? sizes(nested) : [1]
  const columns = along('row')
  const rows = along('column')
  const positions = new Map<PaneId, { column: number; row: number; columns: number; rows: number }>()
  if (root.kind === 'pane') positions.set(root.id, { column: 0, row: 0, columns: 1, rows: 1 })
  else root.children.forEach((id, index) => {
    const child = getNode(state, id)
    const cells = child.kind === 'split' ? child.children : [id]
    cells.forEach((paneId, inner) => {
      const column = root.axis === 'row' ? index : child.kind === 'split' ? inner : 0
      const row = root.axis === 'column' ? index : child.kind === 'split' ? inner : 0
      positions.set(getPane(state, paneId).id, {
        column, row, columns: child.kind === 'pane' && root.axis === 'column' ? columns.length : 1,
        rows: child.kind === 'pane' && root.axis === 'row' ? rows.length : 1,
      })
    })
  })
  const panes = [...positions.keys()].map(id => getPane(state, id))
  const dividers = root.kind === 'split' ? [
    { split: root, column: root.axis === 'row' ? 2 : 1, row: root.axis === 'column' ? 2 : 1,
      columns: root.axis === 'column' ? columns.length : 1, rows: root.axis === 'row' ? rows.length : 1 },
    ...nested === undefined ? [] : [{ split: nested,
      column: root.axis === 'column' ? 2 : nestedIndex * 2 + 1,
      row: root.axis === 'row' ? 2 : nestedIndex * 2 + 1, columns: 1, rows: 1 }],
  ] : []
  const floats = useFloatGestures(state, props.intents)
  const tracks = (fractions: readonly number[]): string => fractions.map(size => `minmax(0, ${size}fr)`).join(' 0px ')
  return (
    <div className={css.tabLayout} data-dockkit-split={root.kind === 'split' ? root.id : undefined}
      style={{ gridTemplateColumns: tracks(columns), gridTemplateRows: tracks(rows) }}>
      {/* Logical order changes must not make React move a connected webview's ancestor. */}
      {Object.values(state.tabs).sort((a, b) => a.id.localeCompare(b.id)).map((tab) => {
        const pane = findTabPane(state, tab.id)
        return <TabHost key={tab.id} {...props} callbacks={tabCallbacks} tab={tab} pane={pane}
          position={positions.get(pane.id) ?? { column: 0, row: 0, columns: 1, rows: 1 }}
          floats={floats} focusRequest={focusRequest} />
      })}
      {panes.filter(pane => pane.tabs.length === 0).map((pane) => {
        const position = positions.get(pane.id)
        if (position === undefined) throw new Error('Missing docked pane position')
        return <div key={pane.id} className={css.emptyTabHost} data-dockkit-empty
          style={{ gridColumn: `${position.column * 2 + 1} / span ${position.columns * 2 - 1}`,
            gridRow: `${position.row * 2 + 1} / span ${position.rows * 2 - 1}` }}>
          <TabPanel state={state} pane={pane} callbacks={callbacks} />
        </div>
      })}
      {dividers.map(({ split, column, row, columns: spanColumns, rows: spanRows }) =>
        <div key={split.id} className={clsx(css.divider, css.tabLayoutDivider,
          split.axis === 'column' && css.tabLayoutDividerColumn)}
        data-dockkit-divider={`${split.id}:0`}
        style={{ gridColumn: `${column} / span ${spanColumns * 2 - 1}`,
          gridRow: `${row} / span ${spanRows * 2 - 1}` }}
        onPointerDown={(event) => { callbacks.onDividerPressed(split.id, 0, event) }} />)}
    </div>
  )
}
