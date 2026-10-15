/** Current input forecast and response reserve, separate from the last request's actual input. */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: the `contextPressure` / `contextBreakdown` projection key merges.
import type {} from '@deepseek-ai/dsh-token-meter/client'
import { Tooltip, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComposerBarProps } from '../contract/slots.ts'
import { contextOccupancy } from '../context-occupancy.ts'
import css from './ContextMeter.module.css'

/** Ring geometry: 14px viewBox, 2px stroke. */
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** Breakdown counts keep their own estimated basis; they never scale to measured usage. */
const ROWS = [
  { key: 'systemTokens', label: 'context.system' },
  { key: 'toolsTokens', label: 'context.tools' },
  { key: 'messageTokens', label: 'context.messages' },
] as const

const QUALITY = {
  observed: 'context.quality.observed',
  'usage-supported': 'context.quality.usage-supported',
  estimated: 'context.quality.estimated',
  incomplete: 'context.quality.incomplete',
} as const

/**
 * Format a token count for the compact context panel.
 * @param value - token count.
 * @param t - Conversation locale seat with shared compact-number templates.
 * @returns Compact localized count using K or M when needed.
 */
function formatTokens(value: number, t: ComposerBarProps['t']): string {
  const scaled = (candidate: number): string => candidate >= 100
    ? String(Math.round(candidate))
    : String(Math.round(candidate * 10) / 10)
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return t('number.thousand', { value: scaled(value / 1_000) })
  return t('number.million', { value: scaled(value / 1_000_000) })
}

export interface ContextMeterProps {
  useProjection: UseProjection
  /** The owning bar's locale seat, passed down as a plain prop. */
  t: ComposerBarProps['t']
}

export function ContextMeter({ useProjection, t }: ContextMeterProps) {
  const pressure = useProjection('contextPressure')
  const breakdown = useProjection('contextBreakdown')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const context = contextOccupancy(pressure)
  const available = context !== null || pressure?.lastObservedInputTokens !== undefined
  const position = useAnchoredPosition({
    open: open && available,
    anchorRef: rootRef,
    panelRef,
    side: 'top',
    gap: 8,
    margin: 12,
  })
  useDismissOnOutsidePointer(rootRef, open && available, setOpen, panelRef)

  // A missing projection closes the panel; unknown capacity still has useful counts.
  useEffect(() => {
    if (!available && open) setOpen(false)
  }, [available, open])

  useEffect(() => {
    if (!open || !available) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false)
        rootRef.current?.querySelector('button')?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [available, open])

  if (!available) return null
  const quality = context === null ? 'incomplete' : pressure?.quality ?? 'estimated'
  const approximate = (value: number) => t('context.approximate', { value: formatTokens(value, t) })
  const percent = context?.percent
  const baseReading = context === null ? t('context.unknown')
    : percent === undefined ? t('context.tokens', { value: approximate(context.usedTokens) })
      : t('context.percent', { value: quality === 'observed' ? String(percent) : t('context.approximate', { value: String(percent) }) })
  const reading = quality === 'incomplete' && context !== null
    ? t('context.uncertainReading', { value: baseReading }) : baseReading
  const label = t('context.aria', { percent: reading, quality: t(QUALITY[quality]) })
  const reserve = pressure?.outputReserveTokens
  const remaining = pressure?.availableTokens
  const critical = remaining !== undefined && remaining < 0
  const residual = pressure?.unattributedTokens ?? breakdown?.unattributedTokens
  const route = (provider: string | undefined, model: string | undefined) => t('context.route', {
    provider: provider ?? t('context.unknown'), model: model ?? t('context.unknown'),
  })

  return (
    <span ref={rootRef} className={css.root} data-critical={critical || undefined}>
      <Tooltip label={label} side="top" delayMs={200} disabled={open}>
        <button
          type="button"
          className={css.trigger}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => { setOpen(!open) }}
        >
          <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
            <circle className={css.track} cx="7" cy="7" r={RADIUS} />
            {percent !== undefined && <circle
              className={css.fill}
              cx="7"
              cy="7"
              r={RADIUS}
              strokeDasharray={`${CIRCUMFERENCE * percent / 100} ${CIRCUMFERENCE}`}
              transform="rotate(-90 7 7)"
            />}
          </svg>
          <span>{reading}</span>
        </button>
      </Tooltip>
      {open && createPortal(
        <div
          ref={panelRef}
          className={css.panel}
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          role="dialog"
          aria-label={t('context.used')}
        >
          <div className={css.header}>
            <span className={css.figures}>{t('context.used')}</span>
            <span>{t(QUALITY[quality])}</span>
          </div>
          {percent !== undefined && <div className={css.bar} aria-hidden>
            {percent > 0 && <div className={css.segment} style={{ width: `${percent}%` }} />}
            {reserve !== undefined && reserve > 0 && context?.contextWindow !== undefined
              && <div className={`${css.segment} ${css.reserve}`} style={{ width: `${Math.min(100, reserve / context.contextWindow * 100)}%` }} />}
          </div>}
          <dl className={css.rows}>
            <div className={css.row}>
              <dt>{t('context.observed')}<span className={css.route}>{route(pressure?.lastObservedProvider, pressure?.lastObservedModel)}</span></dt>
              <dd>{pressure?.lastObservedInputTokens === undefined ? t('context.notReported') : formatTokens(pressure.lastObservedInputTokens, t)}</dd>
            </div>
            <div className={css.row}>
              <dt>{t('context.forecast')}<span className={css.route}>{route(pressure?.provider, pressure?.model)}</span></dt>
              <dd>{context === null ? t('context.unknown') : quality === 'observed' ? formatTokens(context.usedTokens, t) : approximate(context.usedTokens)}</dd>
            </div>
            <div className={css.row}><dt>{t('context.reserve')}</dt><dd>{reserve === undefined ? t('context.unknown') : formatTokens(reserve, t)}</dd></div>
            <div className={css.row}><dt>{t('context.remaining')}</dt><dd>{critical
              ? t('context.overBudget', { value: formatTokens(-remaining, t) })
              : quality === 'incomplete' || remaining === undefined ? t('context.unknown') : approximate(remaining)}</dd></div>
            <div className={css.row}><dt>{t('context.capacity')}</dt><dd>{context?.contextWindow === undefined ? t('context.unknown') : formatTokens(context.contextWindow, t)}</dd></div>
            {residual !== undefined && residual > 0 && <div className={css.row}><dt>{t('context.unattributed')}</dt><dd>{approximate(residual)}</dd></div>}
          </dl>
          {quality === 'incomplete' && <p className={css.note}>{t('context.incomplete')}</p>}
          {breakdown !== undefined && (
            <section aria-label={t('context.breakdown')}>
              <p className={css.note}>{t('context.breakdown')}</p>
              <dl className={css.rows}>
                {ROWS.map(row => (
                  <div key={row.key} className={css.row}>
                    <dt>{t(row.label)}</dt>
                    <dd>{approximate(breakdown[row.key])}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </div>,
        document.body,
      )}
    </span>
  )
}
