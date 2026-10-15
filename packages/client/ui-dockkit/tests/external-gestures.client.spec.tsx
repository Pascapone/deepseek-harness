// @vitest-environment jsdom
import { useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { usePortalDocument } from '@deepseek-ai/dsh-client-ui-primitives'
import { DockLayout } from '../src/components/DockSurface.tsx'
import { seededController, TEST_LABELS } from './fixtures.client.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function rectangle(element: Element, x: number, width: number, height: number): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x, y: 0, width, height, left: x, top: 0, right: x + width, bottom: height, toJSON: () => ({}),
  })
}

it('reorders popup tabs using their owner document even when the main pane has overlapping client coordinates', () => {
  const controller = seededController()
  controller.setExpanded(true)
  const first = controller.openContent({ kind: 'file', contentId: 'a', title: 'A' })
  const paneId = controller.floatTab(first)
  controller.openContent({ kind: 'file', contentId: 'b', title: 'B', paneId })
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const popup = frame.contentDocument!
  const place = vi.spyOn(controller, 'placeTab').mockReturnValue(true)
  const move = vi.spyOn(controller, 'dropTab').mockReturnValue(true)
  const float = vi.spyOn(controller, 'floatTab').mockReturnValue(paneId)
  const h = render(<DockLayout state={controller.getSnapshot().state} canSplit intents={controller}
    labels={TEST_LABELS} renderTab={tab => <input defaultValue={tab.title} />}
    externalPaneTargets={new Map([[paneId, popup.body]])} />)
  for (const pane of [h.container.querySelector('[data-dockkit-pane]')!, popup.querySelector('[data-dockkit-pane]')!]) {
    rectangle(pane, 0, 400, 600)
    rectangle(pane.querySelector('[data-dockkit-strip]')!, 0, 400, 36)
    pane.querySelectorAll('[data-dockkit-tab]').forEach((chip, index) => { rectangle(chip, index * 100, 100, 36) })
  }
  rectangle(h.container.querySelector('[data-dockkit-surface]')!, 0, 400, 600)
  const chip = popup.querySelector(`[data-dockkit-tab="${first}"]`)!
  const pointer = (type: string, x: number): void => {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: 18, button: 0 })
    Object.defineProperty(event, 'pointerId', { value: 7 })
    fireEvent(popup.defaultView!, event)
  }
  fireEvent.pointerDown(chip, { pointerId: 7, clientX: 25, clientY: 18, button: 0 })
  pointer('pointermove', 180)
  expect(popup.querySelector('[data-dockkit-caret]')).not.toBeNull()
  pointer('pointerup', 180)
  expect(place).toHaveBeenCalledExactlyOnceWith(first, paneId, 2)
  expect(move).not.toHaveBeenCalled()
  expect(float).not.toHaveBeenCalled()
  h.unmount()
  frame.remove()
})

it('provides the intended popup document to body overlays on their first commit and the native document on return', () => {
  const controller = seededController()
  const tab = controller.openContent({ kind: 'file', contentId: 'a', title: 'A' })
  const paneId = controller.floatTab(tab)
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const popup = frame.contentDocument!
  const documents: Document[] = []
  function Overlay() {
    const doc = usePortalDocument()
    useLayoutEffect(() => { documents.push(doc) }, [doc])
    return createPortal(<span data-body-overlay />, doc.body)
  }
  const props = { state: controller.getSnapshot().state, canSplit: true, intents: controller,
    labels: TEST_LABELS, renderTab: () => <Overlay /> }
  const h = render(<DockLayout {...props} externalPaneTargets={new Map([[paneId, popup.body]])} />)
  expect(documents).toEqual([popup])
  expect(popup.querySelector('[data-body-overlay]')).not.toBeNull()
  expect(document.querySelector('[data-body-overlay]')).toBeNull()
  act(() => { h.rerender(<DockLayout {...props} externalPaneTargets={new Map()} />) })
  expect(documents).toEqual([popup, document])
  expect(popup.querySelector('[data-body-overlay]')).toBeNull()
  expect(document.querySelector('[data-body-overlay]')).not.toBeNull()
  h.unmount()
  frame.remove()
})

it('routes middle clicks through the native tab callback without starting a drag or closing a tab', () => {
  const controller = seededController()
  controller.setExpanded(true)
  const auxiliary = vi.fn()
  const close = vi.spyOn(controller, 'closeTab')
  const h = render(<DockLayout state={controller.getSnapshot().state} canSplit intents={controller}
    labels={TEST_LABELS} renderTab={tab => tab.title} onTabAuxClick={auxiliary} canCloseTab={() => false} />)
  const chip = h.container.querySelector('[data-dockkit-tab]')!
  expect(fireEvent.pointerDown(chip, { pointerId: 7, button: 1 })).toBe(false)
  expect(chip.hasAttribute('data-dockkit-pointer')).toBe(false)
  expect(fireEvent(chip, new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }))).toBe(false)
  expect(auxiliary).toHaveBeenCalledExactlyOnceWith(chip.getAttribute('data-dockkit-tab'), 1)
  fireEvent.pointerDown(chip, { pointerId: 8, button: 2 })
  fireEvent(chip, new MouseEvent('auxclick', { button: 2, bubbles: true }))
  expect(auxiliary).toHaveBeenCalledTimes(1)
  expect(close).not.toHaveBeenCalled()
})
