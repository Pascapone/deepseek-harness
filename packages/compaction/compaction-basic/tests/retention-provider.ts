/** Engine-test provider; persistence and schema tests live with the product plugin. */
import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import type { CompactionRetentionProvider, RetentionPreference, RetentionValidator } from '../src/retention-settings.ts'
export class TestRetentionSettings extends Service implements CompactionRetentionProvider {
  private readonly validators = new Set<RetentionValidator>()
  constructor(ctx: Context, private readonly config: { retention: Volatile<RetentionPreference> }) {
    super(ctx, 'compactionRetention')
    const validators = this.validators
    const fiber = ctx.fiber
    ctx.on('internal/config', function (_raw: unknown, next: () => unknown) {
      const value = next()
      const candidate = value as { retention: RetentionPreference }
      if (this === fiber) for (const validate of validators) validate(candidate.retention)
      return value
    })
  }
  registerValidator(validate: RetentionValidator): () => void {
    this.validators.add(validate)
    return () => { this.validators.delete(validate) }
  }
  current() {
    const value = this.config.retention.get()
    return value.mode === 'tokens' ? { retainTokens: value.value } : value.mode === 'ratio' ? { retainRatio: value.value } : {}
  }
}
