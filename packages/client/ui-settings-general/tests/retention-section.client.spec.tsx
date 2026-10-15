// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RetentionSection, type RetentionSettings } from '../src/client/RetentionSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const unused = (() => { throw new Error('unused standard hook') }) as never
const useSessions: Parameters<typeof RetentionSection>[0]['useSessions'] = select =>
  select({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })
const kit = {
  close: () => {},
  useSessions,
  useSessionStatus: unused, useSessionRetainInfo: unused,
  usePanelInfo: unused, useResource: unused, useWorkspaces: unused,
}
const t = makeTranslate(en)

function fixture(overrides: Partial<ConfigFormSnapshot<RetentionSettings>> = {}) {
  const state = createSnapshotStore<ConfigFormSnapshot<RetentionSettings>>({
    status: 'ready', value: { retention: { mode: 'tokens', value: 20_000 } },
    base: {}, user: {}, revision: 7, writable: true, mode: 'host', ...overrides,
  })
  const saveRetention = vi.fn(async (retention: RetentionSettings['retention']) => {
    state.set({ ...state.getSnapshot(), value: { retention }, revision: 8 })
    return true
  })
  const props = { ...kit, t, useRetention: bindSnapshotSelector(state), saveRetention }
  return { state, saveRetention, props, ...render(<RetentionSection {...props} />) }
}

it('stages a percentage, saves only its active mode, and reloads the accepted value', async () => {
  const view = fixture()
  expect(screen.getByRole<HTMLInputElement>('spinbutton').value).toBe('20000')
  fireEvent.click(screen.getByRole('radio', { name: 'Percentage' }))
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '5' } })
  expect(view.saveRetention).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => { expect(screen.getByRole('status').textContent).toBe(en['retention.saved']) })
  expect(view.saveRetention).toHaveBeenCalledWith({ mode: 'ratio', value: 0.05 }, 7)
  view.unmount()
  render(<RetentionSection {...view.props} />)
  expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Percentage' }).checked).toBe(true)
  expect(screen.getByRole<HTMLInputElement>('spinbutton').value).toBe('5')
})

it('blocks invalid values, preserves a refused draft and supports reverting to Agent policy', async () => {
  const view = fixture()
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '-1' } })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true)
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '12000' } })
  view.saveRetention.mockResolvedValueOnce(false)
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en['retention.failed']) })
  expect(screen.getByRole<HTMLInputElement>('spinbutton').value).toBe('12000')
  fireEvent.click(screen.getByRole('radio', { name: 'Use Agent configuration' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => { expect(view.saveRetention).toHaveBeenLastCalledWith({ mode: 'inherit', value: 0 }, 7) })
})

it('does not silently fall back to browser-local persistence', () => {
  const view = fixture({ mode: 'memory' })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true)
  expect(screen.getByText(en['retention.hostOnly'])).toBeTruthy()
  expect(view.saveRetention).not.toHaveBeenCalled()
})

it('shows a clear read-only state after Host authorization is denied', () => {
  const view = fixture({ writable: false })
  expect(screen.getByRole('status').textContent).toBe(en['retention.readOnly'])
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(view.saveRetention).not.toHaveBeenCalled()
})

it('shows a snapshot-labeled percentage preview without treating it as a live model decision', () => {
  const view = fixture({ value: { retention: { mode: 'ratio', value: 0.05 } } })
  const sessionId = SessionId('session-a')
  const useSessions: Parameters<typeof RetentionSection>[0]['useSessions'] = select => select({
    ids: [sessionId], byId: {}, phase: 'ready', projectionsBySession: {
      [sessionId]: { state: 'ready', error: null, values: { contextPressure: {
        provider: 'fake', model: 'test', contextWindow: 128_000, outputReserveTokens: 8_000,
        retention: { retainTokens: 12_000, retainRatio: 0.1, source: 'model' },
      } } },
    },
  })
  view.rerender(<RetentionSection {...view.props} useSessions={useSessions} />)
  expect(screen.getByText('Last known model route: fake/test')).toBeTruthy()
  expect(screen.getByText('Last used compaction setting (exact-model policy): 12000 tokens. Retention ratio: 10%.')).toBeTruthy()
  expect(screen.getByText('Last recorded budget: 128000 − 8000 (answer reserve) = 120000 tokens.')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toBe('Target using this budget snapshot: 6000 tokens; not a current compaction decision.')
  expect(Array.from(view.container.querySelectorAll('legend, h2, output')).map(element => element.textContent)).toMatchInlineSnapshot(`
    [
      "Keep original history",
      "Retention mode",
      "Target using this budget snapshot: 6000 tokens; not a current compaction decision.",
    ]
  `)
})
