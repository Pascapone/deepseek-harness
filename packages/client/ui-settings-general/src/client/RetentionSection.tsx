/** Durable original-history retention editor; drafts never change engine policy before save. */
import { useId, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import css from './RetentionSection.module.css'

/** Atomic mode and value understood by the Host settings owner. */
export interface RetentionSettings {
  retention: { mode: 'inherit' | 'tokens' | 'ratio'; value: number }
}

/** Accepted Host values and one revision-fenced write. */
export interface RetentionSectionInjected {
  hooks: { retention: ObservableSnapshot<ConfigFormSnapshot<RetentionSettings>> }
  saveRetention(retention: RetentionSettings['retention'], revision: number | undefined): Promise<boolean>
}

type Props = PropsRuntime<'settings.section'> & PropsLocale<'settings'> & InjectFace<RetentionSectionInjected>

/** Render the accepted setting separately from an unsaved edit.
 * @param props Accepted Host values, writer, standard hooks and localized copy.
 * @returns Accessible retention settings card.
 */
export function RetentionSection({ useRetention, saveRetention, useSessions, t }: Props) {
  const snapshot = useRetention(value => value)
  const sessions = useSessions(value => value)
  const [selectedSession, setSelectedSession] = useState<string>()
  const sessionId = sessions.ids.find(id => id === selectedSession) ?? sessions.ids[0]
  const pressure = sessionId === undefined ? undefined : sessions.projectionsBySession[sessionId]?.values.contextPressure
  const accepted = snapshot.value?.retention
  const [draft, setDraft] = useState<RetentionSettings['retention']>()
  const [text, setText] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<'saved' | 'failed'>()
  const id = useId()
  const preference = draft ?? accepted
  const mode = preference?.mode ?? 'inherit'
  const displayed = text ?? (mode === 'ratio' ? String((preference?.value ?? 0) * 100) : String(preference?.value ?? 0))
  const numeric = Number(displayed)
  const valid = mode === 'inherit' || (displayed.trim() !== '' && Number.isFinite(numeric)
    && (mode === 'tokens' ? Number.isSafeInteger(numeric) && numeric >= 0 : numeric > 0 && numeric <= 100))
  const disabled = busy || snapshot.status !== 'ready' || !snapshot.writable || snapshot.mode !== 'host'
  const inputBudget = pressure?.contextWindow !== undefined && pressure.outputReserveTokens !== undefined
    && pressure.contextWindow > pressure.outputReserveTokens
    ? pressure.contextWindow - pressure.outputReserveTokens : undefined
  const persist = async (): Promise<void> => {
    if (!valid || disabled) return
    setBusy(true)
    setStatus(undefined)
    try {
      const value = mode === 'inherit' ? 0 : mode === 'ratio' ? numeric / 100 : numeric
      const saved = await saveRetention({ mode, value }, snapshot.revision)
      setStatus(saved ? 'saved' : 'failed')
      if (saved) { setDraft(undefined); setText(undefined) }
    } catch (_writeFailure) {
      setStatus('failed')
    } finally { setBusy(false) }
  }
  return <section className={css.section} aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>{t('retention.title')}</h2>
    <p className={css.description}>{t('retention.description')}</p>
    <p className={css.description}>{t('retention.scope')}</p>
    {sessions.ids.length > 0 && <label className={css.value}>
      {t('retention.session')}
      <select value={sessionId} onChange={(event) => { setSelectedSession(event.target.value) }}>
        {sessions.ids.map(id => <option key={id} value={id}>{sessions.byId[id]?.title || id}</option>)}
      </select>
    </label>}
    <p className={css.description}>{pressure?.provider && pressure.model
      ? t('retention.route', { provider: pressure.provider, model: pressure.model })
      : t('retention.noRoute')}</p>
    {inputBudget !== undefined && <p className={css.description}>{t('retention.capacity', {
      window: String(pressure?.contextWindow), reserve: String(pressure?.outputReserveTokens), budget: String(inputBudget),
    })}</p>}
    {pressure?.retention && <p className={css.description}>{t('retention.lastUsed', {
      source: t(`retention.source.${pressure.retention.source}`), tokens: String(pressure.retention.retainTokens),
    })}{pressure.retention.retainRatio !== undefined && ` ${t('retention.lastRatio', {
      percent: String(pressure.retention.retainRatio * 100),
    })}`}</p>}
    <form onSubmit={(event) => { event.preventDefault(); void persist() }}>
      <fieldset className={css.fields} disabled={disabled}>
        <legend>{t('retention.mode')}</legend>
        {(['inherit', 'tokens', 'ratio'] as const).map(option => <label key={option} className={css.choice}>
          <input type="radio" name={`${id}-mode`} value={option} checked={mode === option}
            onChange={() => {
              setDraft({ mode: option, value: 0 })
              setText('')
              setStatus(undefined)
            }} />
          {t(`retention.${option}`)}
        </label>)}
        {mode !== 'inherit' && <label className={css.value} htmlFor={`${id}-value`}>
          {t(mode === 'tokens' ? 'retention.tokensValue' : 'retention.ratioValue')}
          <Input id={`${id}-value`} type="number" min={mode === 'ratio' ? '0.000001' : '0'}
            max={mode === 'ratio' ? '100' : undefined} step={mode === 'ratio' ? 'any' : '1'}
            value={displayed} required aria-describedby={`${id}-basis`} aria-invalid={!valid}
            onChange={(event) => { setText(event.target.value); setStatus(undefined) }} />
        </label>}
        <p id={`${id}-basis`} className={css.description}>{t('retention.basis')}</p>
        {mode === 'ratio' && valid && inputBudget !== undefined && <output className={css.description}>
          {t('retention.preview', { tokens: String(Math.floor(inputBudget * numeric / 100)) })}
        </output>}
        <Button type="submit" disabled={disabled || !valid}>{t(busy ? 'retention.saving' : 'retention.save')}</Button>
      </fieldset>
    </form>
    {snapshot.status !== 'ready' && <p role="status">{t('retention.unavailable')}</p>}
    {snapshot.status === 'ready' && !snapshot.writable && <p role="status">{t('retention.readOnly')}</p>}
    {snapshot.mode !== 'host' && <p role="status">{t('retention.hostOnly')}</p>}
    <p className={css.description}>{t('retention.timing')}</p>
    <p className={css.description}>{t('retention.modelPolicy')}</p>
    {status && <p role={status === 'failed' ? 'alert' : 'status'}>{t(`retention.${status}`)}</p>}
  </section>
}
