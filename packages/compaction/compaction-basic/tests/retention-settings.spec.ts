import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import CompactionRetentionSettings, { RetentionPreferenceSchema, type RetentionPreference } from '../src/retention-settings.ts'

describe('durable compaction retention preference', () => {
  it('switches mode without fixed-token precedence and detaches running snapshots', () => {
    let value: RetentionPreference = { mode: 'tokens', value: 20_000 }
    const service = new CompactionRetentionSettings(new Context(), { retention: { get: () => value } })
    const running = service.current()
    expect(running).toEqual({ retainTokens: 20_000 })
    value = { mode: 'ratio', value: 0.05 }
    expect(service.current()).toEqual({ retainRatio: 0.05 })
    expect(running).toEqual({ retainTokens: 20_000 })
    value = { mode: 'inherit', value: 0 }
    expect(service.current()).toEqual({})
  })

  it('rejects invalid persisted values before an operation can consume them', () => {
    for (const value of [
      { mode: 'tokens', value: -1 }, { mode: 'tokens', value: 1.5 },
      { mode: 'ratio', value: 0 }, { mode: 'ratio', value: 1.01 },
    ] satisfies RetentionPreference[]) expect(() => RetentionPreferenceSchema(value)).toThrow()
    // @ts-expect-error -- persisted data can contain an undeclared mode.
    expect(() => RetentionPreferenceSchema({ mode: 'other', value: 5 })).toThrow()
    expect(RetentionPreferenceSchema({ mode: 'ratio', value: 0.05 })).toEqual({ mode: 'ratio', value: 0.05 })
  })

  it('runs known-model validators on the shared ConfigEditor path and removes disposed validators', () => {
    const ctx = new Context()
    const service = new CompactionRetentionSettings(ctx, { retention: { get: () => ({ mode: 'inherit', value: 0 }) } })
    const dispose = service.registerValidator((preference) => {
      if (preference.mode === 'tokens' && preference.value >= 30_000) throw new Error('retention exceeds known model budget')
    })
    const validate = (value: number): unknown => {
      const candidate = { retention: { mode: 'tokens', value } }
      return ctx.waterfall(ctx.fiber, 'internal/config', candidate, () => candidate)
    }
    expect(() => validate(30_000)).toThrow('retention exceeds known model budget')
    expect(() => validate(Number.NaN)).toThrow()
    expect(validate(20_000)).toEqual({ retention: { mode: 'tokens', value: 20_000 } })
    const sibling = ctx.plugin(() => {})
    const siblingConfig = { unrelated: true }
    expect(ctx.waterfall(sibling, 'internal/config', siblingConfig, () => siblingConfig)).toEqual(siblingConfig)
    dispose()
    expect(validate(30_000)).toEqual({ retention: { mode: 'tokens', value: 30_000 } })
  })
})
