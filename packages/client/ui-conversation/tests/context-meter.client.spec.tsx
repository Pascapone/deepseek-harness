// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn, zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/index.ts'
import { ContextMeter, type ContextMeterProps } from '../src/client/skeleton/ContextMeter.tsx'
import { contextOccupancy } from '../src/client/context-occupancy.ts'
import css from '../src/client/skeleton/ContextMeter.module.css'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh) as ContextMeterProps['t']
const tEn = makeTranslate(en, commonEn) as ContextMeterProps['t']
const BREAKDOWN = { systemTokens: 120, toolsTokens: 21_500, messageTokens: 477_000, quality: 'estimated' }
const FORECAST = { projectedTokens: 32_000, contextWindow: 128_000, quality: 'usage-supported', provider: 'current', model: 'new-model',
  lastObservedInputTokens: 64_000, lastObservedProvider: 'previous', lastObservedModel: 'old-model',
  outputReserveTokens: 16_000, availableTokens: 80_000, unattributedTokens: 4_000,
}

function projections(values: Record<string, unknown>): ContextMeterProps['useProjection'] {
  return (key: string) => values[key]
}

function meter(values: Record<string, unknown>, translate: ContextMeterProps['t'] = tEn) {
  return render(<ContextMeter useProjection={projections(values)} t={translate} />)
}

function open(view: ReturnType<typeof meter>): HTMLElement {
  fireEvent.click(view.getByRole('button'))
  return view.getByRole('dialog')
}

function row(panel: HTMLElement, label: string): Element {
  const term = [...panel.querySelectorAll('dt')].find(value => value.textContent?.startsWith(label))
  if (term?.parentElement === null || term?.parentElement === undefined) throw new Error(`missing row ${label}`)
  return term.parentElement
}

describe('ContextMeter', () => {
  it('uses only the current forecast for occupancy and never combines an old observation with a new capacity', () => {
    expect(contextOccupancy({ pressureTokens: 32_000, projectedTokens: 6_000, contextWindow: 128_000 }))
      .toEqual({ percent: 5, usedTokens: 6_000, contextWindow: 128_000 })
    expect(contextOccupancy({ pressureTokens: 32_000, contextWindow: 128_000 })).toBeNull()
    expect(contextOccupancy({ projectedTokens: 32_000 })).toEqual({ usedTokens: 32_000 })
    expect(contextOccupancy({ projectedTokens: 1, contextWindow: 0 })).toEqual({ usedTokens: 1 })
    expect(contextOccupancy({ contextWindow: 128_000 })).toBeNull()
    expect(contextOccupancy(undefined)).toBeNull()
    expect(contextOccupancy({ projectedTokens: 300_000, contextWindow: 128_000 })?.percent).toBe(100)
  })

  it('renders nothing without a current forecast or explicit historical observation', () => {
    expect(meter({}).container.textContent).toBe('')
    expect(meter({ contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 } }).container.textContent).toBe('')
  })

  it('separates actual input and its old route from forecast, reserve, remaining space, and residual', () => {
    const view = meter({ contextPressure: FORECAST, contextBreakdown: BREAKDOWN })
    const trigger = view.getByRole('button', { name: 'Next input ~25% (Usage-supported forecast)' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    const panel = open(view)
    expect(row(panel, 'Last request actual input').textContent).toBe('Last request actual inputprevious / old-model64K')
    expect(row(panel, 'Next request forecast input').textContent).toBe('Next request forecast inputcurrent / new-model~32K')
    expect(row(panel, 'Reserved for response').textContent).toContain('16K')
    expect(row(panel, 'Forecast space after reserve').textContent).toContain('~80K')
    expect(row(panel, 'Unattributed input').textContent).toContain('~4K')
    expect(row(panel, 'Context window').textContent).toContain('128K')
    expect(row(panel, 'Tool definitions').textContent).toContain('~21.5K')
    expect(row(panel, 'Messages').textContent).toContain('~477K')
    // A deliberately mismatched category sum must never be scaled to actual usage or the input bar.
    const segments = panel.getElementsByClassName(css.segment!)
    expect(segments).toHaveLength(2)
    expect((segments[0] as HTMLElement).style.width).toBe('25%')
    expect((segments[1] as HTMLElement).style.width).toBe('12.5%')
    fireEvent.click(trigger)
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('localizes forecast quality and both observation labels in Chinese', () => {
    const view = meter({ contextPressure: { ...FORECAST, quality: 'estimated' } }, t)
    expect(view.getByRole('button', { name: '预计输入 ~25%（估算）' })).toBeTruthy()
    const panel = open(view)
    expect(panel.getAttribute('aria-label')).toBe('上下文预算')
    expect(row(panel, '上次请求实际输入').textContent).toContain('64K')
    expect(row(panel, '下次请求预计输入').textContent).toContain('~32K')
    expect(panel.textContent).toContain('回复预留16K')
  })

  it('keeps unknown capacity visible without inventing a percentage or available-space number', () => {
    const view = meter({ contextPressure: { projectedTokens: 32_000, quality: 'estimated' } })
    expect(view.getByRole('button').textContent).toBe('~32K tokens')
    const panel = open(view)
    expect(panel.textContent).not.toContain('%')
    expect(row(panel, 'Context window').textContent).toBe('Context windowUnknown')
    expect(row(panel, 'Forecast space after reserve').textContent).toBe('Forecast space after reserveUnknown')
    expect(panel.getElementsByClassName(css.segment!)).toHaveLength(0)
    expect(row(panel, 'Last request actual input').textContent).toContain('Not reported yet')
  })

  it('shows a historical observation without treating it as the forecast for a replacement route', () => {
    const view = meter({ contextPressure: { lastObservedInputTokens: 32_000, lastObservedProvider: 'old', lastObservedModel: 'm', contextWindow: 64_000 } })
    expect(view.getByRole('button').textContent).toBe('Unknown')
    const panel = open(view)
    expect(row(panel, 'Last request actual input').textContent).toContain('32K')
    expect(row(panel, 'Next request forecast input').textContent).toContain('Unknown')
    expect(panel.textContent).not.toContain('%')
  })

  it('marks incomplete forecasts and never labels a positive remainder as safely available', () => {
    const view = meter({ contextPressure: { ...FORECAST, quality: 'incomplete' } })
    expect(view.getByRole('button').textContent).toBe('~25% ?')
    const panel = open(view)
    expect(panel.textContent).toContain('Incomplete cost coverage')
    expect(panel.textContent).toContain('Some input costs are unknown; remaining space is not a safe limit.')
    expect(row(panel, 'Forecast space after reserve').textContent).toBe('Forecast space after reserveUnknown')
  })

  it('shows over-budget pressure independently from estimate quality', () => {
    const view = meter({ contextPressure: { ...FORECAST, quality: 'incomplete', availableTokens: -1500 } })
    const panel = open(view)
    expect(row(panel, 'Forecast space after reserve').textContent).toContain('1.5K tokens over budget')
    expect(view.container.querySelector('[data-critical]')).not.toBeNull()
  })

  it('draws no segment for zero input and preserves explicit zero observations', () => {
    const view = meter({ contextPressure: { projectedTokens: 0, lastObservedInputTokens: 0, contextWindow: 128_000, quality: 'observed' } })
    expect(view.getByRole('button').textContent).toBe('0%')
    const panel = open(view)
    expect(panel.getElementsByClassName(css.segment!)).toHaveLength(0)
    expect(row(panel, 'Last request actual input').textContent).toContain('0')
    expect(row(panel, 'Next request forecast input').textContent).not.toContain('~')
  })

  it('formats large forecasts and omits missing breakdowns', () => {
    const view = meter({ contextPressure: { projectedTokens: 1_250_000, contextWindow: 2_000_000 } })
    const panel = open(view)
    expect(row(panel, 'Next request forecast input').textContent).toContain('~1.3M')
    expect(panel.textContent).not.toContain('Forecast input components')
  })

  it('closes when all data disappears and stays closed when it returns', () => {
    let values: Record<string, unknown> = { contextPressure: FORECAST }
    const view = render(<ContextMeter useProjection={(key: string) => values[key]} t={tEn} />)
    open(view)
    values = {}
    view.rerender(<ContextMeter useProjection={(key: string) => values[key]} t={tEn} />)
    expect(view.queryByRole('dialog')).toBeNull()
    expect(view.container.textContent).toBe('')
    values = { contextPressure: FORECAST }
    view.rerender(<ContextMeter useProjection={(key: string) => values[key]} t={tEn} />)
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })

  it('dismisses outside clicks and Escape, restores focus, and retains inside clicks', () => {
    const view = meter({ contextPressure: FORECAST })
    const panel = open(view)
    fireEvent.pointerDown(panel)
    expect(view.queryByRole('dialog')).not.toBeNull()
    fireEvent.pointerDown(document.body)
    expect(view.queryByRole('dialog')).toBeNull()
    open(view)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(view.getByRole('button'))
  })
})
