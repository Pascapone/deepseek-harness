/**
 * Default model selection for an Agent without a session-specific selection.
 *
 * @module @deepseek-ai/dsh-agent-default-model
 */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile } from '@deepseek-ai/cordis'

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { NamedEntries, ScopedLayers, scopeOf } from '@deepseek-ai/dsh-scope'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-config-editor'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Default model selection for Agents created without an explicit model. */
    agentDefaultModel: AgentDefaultModelConfig
  }
}

/** Default model selection supplied by plugin configuration. */
export interface Config {
  /** Registered provider route. */
  provider: Volatile<string>
  /** Provider-owned model id. */
  model: Volatile<string>
  /** Adapter-owned reasoning effort; omission follows the provider default. */
  reasoningEffort: Volatile<string | undefined>
}

/** Project stored settings onto the Agent-facing selection type. */
function selection(settings: { provider: string; model: string; reasoningEffort?: string }): ModelSelection {
  return {
    provider: settings.provider,
    model: settings.model,
    ...settings.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(settings.reasoningEffort) },
  }
}

/**
 * Owns the default model selection independently of any Host or transport.
 * Scoped registrations take precedence over the live deployment Config references.
 */
export class AgentDefaultModelConfig extends Service {
  static Config = z.object({
    provider: z.string().required().volatile(),
    model: z.string().required().volatile(),
    reasoningEffort: z.string().volatile(),
  })

  private readonly scoped = new ScopedLayers(
    () => new NamedEntries<ModelSelection>(() => new Error('A model default is already registered in this scope')),
    () => {},
  )

  constructor(private readonly ownerContext: Context, private config: Config) {
    super(ownerContext, 'agentDefaultModel')

    ownerContext.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ownerContext.fiber)) })
  }

  /**
   * Register one fallback for the calling scope and its descendants without writing the profile.
   * Duplicate registrations in one scope and unscoped callers fail. Unloading the owner removes it.
   * @param next - selection whose route availability is validated by the request consumer.
   * @returns the disposer for this registration.
   */
  registerScoped(next: ModelSelection): () => void {
    if (scopeOf(this.ctx) === undefined) throw new Error('Scoped model defaults require a scope')
    const value = selection(next)
    return this.scoped.effect(this.ctx, layer => layer.insert('default', value), { label: 'agent-default-model: scoped default', notify: false })
  }

  /**
   * Read the nearest scoped default, falling back to the live profile selection.
   * @param scope - target identity; omission uses the calling context's scope.
   * @returns a detached provider, model, and optional reasoning selection.
   */
  currentSelection(scope: ScopeKey | undefined = scopeOf(this.ctx)): ModelSelection {
    const scoped = this.scoped.chainLayers(scope).at(-1)?.get('default')
    if (scoped !== undefined) return { ...scoped }
    const reasoningEffort = this.config.reasoningEffort.get()
    return selection({
      provider: this.config.provider.get(), model: this.config.model.get(),
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    })
  }

  /**
   * Save the complete deployment default selection. A deployment without a configuration
   * editor keeps its composition entry.
   * @param next - resolved selection accepted by an entry point.
   * @returns fulfillment after the optional profile write settles.
   */
  async saveSelection(next: ModelSelection): Promise<void> {
    const entry = this.ownerContext.fiber.entry
    if (entry === undefined) return
    await this.ctx.get('configEditor')?.edit(entry, () => ({
      provider: next.provider, model: next.model,
      ...next.reasoningEffort === undefined ? {} : { reasoningEffort: String(next.reasoningEffort) },
    }))
  }
}

export default AgentDefaultModelConfig
