/** Optional retention preference provider consumed by compaction engines. */
import type { CompactionPolicyConfig } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional global preference; exact-model policies take precedence. */
    compactionRetention: CompactionRetentionProvider
  }
}

/** Atomic retention preference validated by its settings owner. */
export type RetentionPreference =
  | { mode: 'inherit'; value: 0 }
  | { mode: 'tokens'; value: number }
  | { mode: 'ratio'; value: number }

/** Pure known-route budget check; throws to reject a proposed preference. */
export type RetentionValidator = (preference: Readonly<RetentionPreference>) => void

/** Settings ownership is optional; native engines own budget checks. */
export interface CompactionRetentionProvider {
  /** Read one detached operation snapshot.
   * @returns Retention override, or neither field to inherit native configuration.
   */
  current(): Pick<CompactionPolicyConfig, 'retainTokens' | 'retainRatio'>
  /** Guard future settings writes with an active engine's known-route budget checks.
   * @param validate Synchronous budget check; throws before persistence.
   * @returns Disposer owned by the engine's effect.
   */
  registerValidator(validate: RetentionValidator): () => void
}
