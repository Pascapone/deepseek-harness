/** Host-owned retention preference sampled at the start of compaction. */
import { Context, Service, type Fiber, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CompactionPolicyConfig } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable global retention preference; exact-model retention policies still win. */
    compactionRetention: CompactionRetentionSettings
  }
}

/** Explicit mode prevents a previously saved fixed budget from overriding ratio mode. */
export type RetentionPreference =
  | { mode: 'inherit'; value: 0 }
  | { mode: 'tokens'; value: number }
  | { mode: 'ratio'; value: number }

/** Loader-owned live setting. */
export interface Config {
  retention: Volatile<RetentionPreference>
}

/** Validate a proposed preference against an engine's known route capacities without I/O. */
export type RetentionValidator = (preference: Readonly<RetentionPreference>) => void

/** Validated atomic preference, persisted through the ordinary Settings registry. */
export const RetentionPreferenceSchema: z<RetentionPreference> = z.union([
  z.object({ mode: z.const('inherit').required(), value: z.const(0).default(0) }),
  z.object({ mode: z.const('tokens').required(), value: z.number().min(0).max(Number.MAX_SAFE_INTEGER).step(1).required() }),
  z.object({ mode: z.const('ratio').required(), value: z.number().min(Number.MIN_VALUE).max(1).required() }),
])

/** Global settings owner shared by preset-scoped compaction engines. */
export default class CompactionRetentionSettings extends Service {
  static Config = z.object({
    retention: RetentionPreferenceSchema.default({ mode: 'inherit', value: 0 }).volatile(),
  })

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'compactionRetention')
    assertFinitePreference(config.retention.get())
    const owner = ctx.fiber
    const validators = this.validators
    // ConfigEditor and Loader validate this fiber's raw configuration through
    // internal/config before persistence; sibling plugin configurations are not ours.
    ctx.on('internal/config', function (this: Fiber, _raw: unknown, next: () => unknown) {
      const candidate = next()
      if (this !== owner) return candidate
      const parsed = CompactionRetentionSettings.Config(candidate as { retention?: RetentionPreference })
      const current = parsed.retention.get()
      const preference: RetentionPreference = current.mode === 'inherit' ? { mode: 'inherit', value: 0 }
        : current.mode === 'tokens' ? { mode: 'tokens', value: current.value } : { mode: 'ratio', value: current.value }
      assertFinitePreference(preference)
      for (const validate of validators) validate(preference)
      return candidate
    })
  }

  private readonly validators = new Set<RetentionValidator>()

  /** Enforce an active engine's known-model budget before any Settings or ConfigEditor write.
   * @param validate Synchronous validation; throw an actionable error to reject the entire write.
   * @returns Disposer, owned by the engine's plugin effect.
   */
  registerValidator(validate: RetentionValidator): () => void {
    this.validators.add(validate)
    return () => { this.validators.delete(validate) }
  }

  /** Read a detached override for one operation; running operations retain their snapshot.
   * @returns Only the active retention field, or neither when inheriting engine configuration.
   */
  current(): Pick<CompactionPolicyConfig, 'retainTokens' | 'retainRatio'> {
    const preference = this.config.retention.get()
    assertFinitePreference(preference)
    if (preference.mode === 'tokens') return { retainTokens: preference.value }
    if (preference.mode === 'ratio') return { retainRatio: preference.value }
    return {}
  }
}

/** Schemastery's numeric ranges do not reject YAML .nan values. */
function assertFinitePreference(preference: Readonly<RetentionPreference>): void {
  if (!Number.isFinite(preference.value)) throw new Error('compaction retention value must be finite')
}
