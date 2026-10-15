/**
 * Basic replay-aware compaction backend.
 *
 * @module @deepseek-ai/dsh-compaction-basic
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CompactionEngine, isCompactCheckpointSource, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { RequestContext, Session } from '@deepseek-ai/dsh-session'
import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
// Type-only: makes the optional sibling service available to `ctx.get()`.
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import {
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
  TargetPressureConfigError,
  CompactionBudgetError,
} from './config.ts'
import {
  assertNoActiveCompaction,
  compactSurfaceRegion,
  selectCompactableRange,
  safeCompactionEnds,
  buildSummarizationInput,
} from './region.ts'
import { frameSummary, prepareSummarization, summarizeWithLlm } from './summarizer.ts'
import type { RetentionPreference } from './retention-settings.ts'
import type { SummarizationInput, SummaryResult } from './summarizer.ts'
import type {
  BasicCompactionConfig,
  ModelCompactPolicyConfig,
  ResolvedConfig,
  ResolvedTargetPolicy,
  ResolvedCompactSpec,
} from './types.ts'

export type {
  BasicCompactionConfig,
  CompactionPolicyConfig,
  ModelCompactPolicyConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedRetention,
  ResolvedTargetPolicy,
} from './types.ts'

export { CompactionBudgetError } from './config.ts'

interface CompactionOperation {
  readonly policy: ResolvedTargetPolicy
  remainingCalls: number
}

/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(
  session: Session,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

/**
 * Output tokens the routed request reserves, which the provider charges to the
 * same window as the prompt. A captured provider-adjusted reserve wins over
 * the envelope's plain cap and the adapter default. Absence remains unknown
 * in public measurement; legacy text-only policy scaling uses zero.
 */
function reservedCompletionTokens(agent: Agent, defaultMaxTokens: number | undefined, measured?: number): number {
  const configured = agent.session.requestHeader()?.config.maxTokens
  return measured ?? configured ?? defaultMaxTokens ?? 0
}

/** Resolve the conversation target used to select an optional policy override. */
function conversationTarget(
  agent: Agent,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const routed = routedTarget(agent.session)
  if (routed !== undefined) return routed
  if (agent.options.provider === undefined || agent.options.provider.length === 0
    || agent.options.model === undefined || agent.options.model.length === 0) return undefined
  return { provider: agent.options.provider, model: agent.options.model }
}

const thresholdRatioSchema = z.number()
const headroomTokensSchema = z.number().step(1).min(0)
const retainRatioSchema = z.number()
const retainTokensSchema = z.number().step(1).min(0)
const summarizationProviderSchema = z.string()
const summarizationModelSchema = z.string()
const maxTokensSchema = z.number().step(1).min(1)
const compactionRetriesSchema = z.number().step(1).min(0)
const maxOverflowRetriesSchema = z.number().step(1).min(0)

const modelPolicy: z<ModelCompactPolicyConfig> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: thresholdRatioSchema,
  headroomTokens: headroomTokensSchema,
  retainRatio: retainRatioSchema,
  retainTokens: retainTokensSchema,
  summarizationProvider: summarizationProviderSchema,
  summarizationModel: summarizationModelSchema,
  maxTokens: maxTokensSchema,
  compactionRetries: compactionRetriesSchema,
  maxOverflowRetries: maxOverflowRetriesSchema,
})

/**
 * Dependency-light compaction backend using `ctx.tokenMeter` for pressure,
 * retention, cited source events, and summary-convergence pricing.
 *
 * `summarize()` is the sole subclass customization hook; the replay and durable
 * mutation strategy stays fixed so every pricing decision uses the singleton
 * token meter.
 */
export class BasicCompactionEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  static Config: z<BasicCompactionConfig> = z.object({
    thresholdRatio: thresholdRatioSchema,
    headroomTokens: headroomTokensSchema,
    retainRatio: retainRatioSchema,
    retainTokens: retainTokensSchema,
    summarizationProvider: summarizationProviderSchema,
    summarizationModel: summarizationModelSchema,
    maxTokens: maxTokensSchema,
    compactionRetries: compactionRetriesSchema,
    maxOverflowRetries: maxOverflowRetriesSchema,
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
  })

  /** Resolved and validated compaction configuration. */
  readonly config: ResolvedConfig

  private readonly warnedPressureConfigTargets = new Set<string>()
  private readonly overflowRetries = new WeakMap<Agent, number>()
  private readonly overflowAgents = new WeakMap<Session, Agent>()
  private readonly operations = new WeakMap<Agent, CompactionOperation>()
  private readonly knownTargets = new Map<string, { provider: string; model: string; contextWindow: number; reserve: number }>()

  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    ctx.inject(['compactionRetention'], (scoped) => {
      scoped.effect(() => scoped.compactionRetention.registerValidator((preference) =>{  this.validateRetention(preference) }))
    })
    if (this.config.auto) this._registerAutomaticCompaction()
  }

  /**
   * Register automatic between-step pressure and model-request overflow
   * recovery. `compactIfNeeded` stays dynamically dispatched so subclass
   * overrides are honored at event time.
   */
  private _registerAutomaticCompaction(): void {
    const { ctx } = this
    const logResult = (result: CompactionResult, trigger: string): void => {
      ctx.logger.info(
        `compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes `
        + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
        + `~${result.shadowedTokenCount} tokens)`,
      )
    }

    ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          if (result !== null) logResult(result, 'step pressure')
        } catch (error: unknown) {
          if (error instanceof CompactionBudgetError) throw error
          if (error instanceof TargetPressureConfigError) {
            if (this.warnedPressureConfigTargets.has(error.targetKey)) return next()
            this.warnedPressureConfigTargets.add(error.targetKey)
          }
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })

    // A successful response starts a fresh overflow-recovery sequence even
    // when tool calls continue the same turn into another request.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = this.overflowAgents.get(session)
      if (agent !== undefined) this.overflowRetries.delete(agent)
    })

    ctx.on('agent/request-error', async (
      { agent, failure, signal },
      next,
    ) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      this.overflowAgents.set(agent.session, agent)
      const target = routedTarget(agent.session)
      if (target === undefined) return next()
      const policy = this.policyFor(target)
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= policy.maxOverflowRetries) return next()

      const generation = agent.session.surface.replaceGeneration
      let result: CompactionResult | null
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (recoveryError: unknown) {
        if (recoveryError instanceof CompactionBudgetError) throw recoveryError
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        // A model-free prune can land before later summary work fails. That
        // durable reduction is sufficient retry proof; do not discard it just
        // because the optional second phase threw. Cancellation still wins.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(
            `context-overflow compaction failed after durable surface progress: ${message}; `
            + 'retrying from the replacement surface',
          )
          this.overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        ctx.logger.warn(
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
          `context-overflow compaction failed: ${message}; ${signal.aborted
            ? 'cancellation prevents retry'
            : 'preserving the original request error'}`,
        )
        return next()
      }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while compaction is awaited.
      if (signal.aborted
        || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) logResult(result, 'context overflow recovery')
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
  }

  /**
   * Summarize the replayed conversation region through a direct one-shot
   * `ctx.llm.stream()` call whose prefix reuses the conversation's own system
   * prompt, tools, and messages so the provider's KV cache is not invalidated.
   * Override this sole hook for a template or remote summarizer.
   * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns safe text summary blocks and the exact auxiliary call envelope and output.
   */
  protected async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const target = conversationTarget(agent)
    const config = target === undefined
      ? this.config
      : this.operations.get(agent)?.policy ?? this.policyFor(target)
    return summarizeWithLlm(this.ctx, config, input, agent, signal)
  }

  /**
   * Compact for replayed step-boundary pressure or one provider-confirmed context
   * overflow. Both triggers price the latest durable routed request envelope;
   * overflow bypasses the normal threshold and retained-tail policy so it can
   * force one useful balanced reduction.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal step-boundary pressure or context-overflow recovery.
   * @param signal - live turn cancellation signal forwarded to summarization.
   * @returns the latest summary compaction result, or `null` when no summary ran.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const target = routedTarget(agent.session)
    if (target === undefined) return null
    assertNoActiveCompaction(agent.session, 'automatic pressure compaction')
    const policy = this.policyFor(target)
    const meter = this.ctx.tokenMeter
    let measurement = meter.refresh(agent.session)
    switch (trigger) {
      case 'context-overflow':
        break
      case 'pressure':
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(trigger, 'compaction trigger')
    }

    const prune = this.ctx.get('toolResultPruner')
    const spec = await this.resolveSpec(agent, policy, measurement, signal)
    assertNoActiveCompaction(agent.session, 'automatic pressure compaction')
    this.recordPolicy(agent.session, policy, spec)
    measurement = meter.refresh(agent.session)
    if (trigger === 'pressure' && measurement.inputTokens < spec.thresholdTokens) return null
    const generation = agent.session.surface.replaceGeneration
    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = meter.refresh(agent.session)
    }
    if (agent.session.surface.replaceGeneration > generation && measurement.inputTokens <= spec.targetTokens && !measurement.nodes.some(node => node.quality === 'incomplete')) return null
    if (trigger === 'pressure' && measurement.inputTokens <= spec.targetTokens) return null
    return this.withOperation(agent, policy, async () => {
      let targetTokens: number | undefined
      for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
        const range = selectCompactableRange(agent.session, measurement, trigger === 'context-overflow' ? 0 : spec.retainTokens)
        if (range === null) throw new CompactionBudgetError(`compaction has no safe useful range while input ${measurement.inputTokens} remains critical (target ${spec.targetTokens}); retained or indivisible input cannot be reduced`)
        targetTokens = this.assertPossibleGoal(measurement, range, spec, policy.headroomTokens, targetTokens)
        const result = await this.compactRegion(range.start, range.end, agent, signal)
        measurement = meter.refresh(agent.session)
        if (measurement.inputTokens <= targetTokens && !measurement.nodes.some(node => node.quality === 'incomplete')) return result
      }
      throw new CompactionBudgetError(`compaction still above target after ${spec.compactionRetries + 1} compaction attempts (${measurement.inputTokens} input tokens; target ${targetTokens ?? spec.targetTokens})`)
    })
  }

  /**
   * Compact one inclusive positional range from the agent-owned surface using
   * the effective token meter for all retention and shrink pricing.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session, used by the summarizer.
   * @param signal - optional summarization cancellation signal.
   * @returns the successful durable compaction result.
   */
  override async compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    assertNoActiveCompaction(agent.session, 'compaction')
    const measurement = this.ctx.tokenMeter.refresh(agent.session)
    if (measurement.nodes.length !== agent.session.surface.nodes.length || measurement.nodes.some((node, index) => node.seq !== agent.session.surface.nodes[index])) throw new Error('compaction: selected surface changed before summarization began')
    const target = conversationTarget(agent)
    const policy = this.operations.get(agent)?.policy ?? this.policyFor(target ?? { provider: '', model: '' })
    return this.withOperation(agent, policy, operation => this.compactChosen(start, end, agent, operation,
      { owner: 'current-turn', stability: 'whole-surface' }, signal))
  }

  /**
   * Force one useful idle-session compaction below the pressure threshold, and
   * resolve only after its standalone marker pair is durably checkpointed.
   * @param agent - idle agent whose next-turn admission this call reserves.
   * @param signal - cancellation scoped to this compaction request.
   * @param sourceCommandId - initiating command identity for presentation correlation.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  override compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          assertNoActiveCompaction(agent.session, 'manual compaction')
          const target = conversationTarget(agent)
          if (target === undefined) return null
          const policy = this.policyFor(target)
          const preview = this.ctx.tokenMeter.preview(agent.session)
          const spec = await this.resolveSpec(agent, policy, preview.measurement, operationSignal)
          operationSignal.throwIfAborted()
          const { retainTokens: _tokens, retainRatio: _ratio, ...inheritedPolicy } = policy
          const manualPolicy: ResolvedTargetPolicy = policy.explicitRetention ? policy : { ...inheritedPolicy, retainTokens: 0 }
          const manualSpec = policy.explicitRetention ? spec : { ...spec, retainTokens: 0 }
          const pricing = this.policyContext(agent.session, manualPolicy, manualSpec, preview.context)
          const range = selectCompactableRange(
            agent.session,
            preview.measurement,
            policy.explicitRetention ? spec.retainTokens : 0,
          )
          if (range === null) {
            if (preview.measurement.inputTokens >= spec.thresholdTokens) throw new CompactionBudgetError(`manual compaction has no safe useful range while input ${preview.measurement.inputTokens} remains critical (target ${spec.targetTokens})`)
            return null
          }
          const targetTokens = preview.measurement.inputTokens >= spec.thresholdTokens
            ? this.assertPossibleGoal(preview.measurement, range, spec, policy.headroomTokens) : spec.targetTokens
          const result = await this.withOperation(agent, manualPolicy,
            operation => this.compactChosen(range.start, range.end, agent, operation, {
              owner: null,
              stability: 'selected-span',
              ...pricing === undefined ? {} : { pricing },
              ...sourceCommandId === undefined ? {} : { sourceCommandId },
              flush: async () => {
                await this.ctx.sessions.flush(agent.session)
              },
            }, operationSignal))
          const after = this.ctx.tokenMeter.measure(agent.session)
          if (after.inputTokens > targetTokens || after.nodes.some(node => node.quality === 'incomplete')) throw new CompactionBudgetError(`manual compaction made progress but input ${after.inputTokens} is not safely below target ${targetTokens}`)
          return result
        } catch (error: unknown) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError(
              'cancelled',
              'manual compaction was cancelled',
              { cause: error },
            )
          }
          operationSignal.throwIfAborted()
          throw error
        }
      })
    } catch (error: unknown) {
      throw new ManualCompactionError(
        'busy',
        'manual compaction requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }

  /** Capture Settings once; an exact-model retention declaration remains authoritative. */
  private policyFor(target: Pick<LlmCallConfig, 'provider' | 'model'>): ResolvedTargetPolicy {
    return resolveTargetPolicy(this.config, target, this.ctx.get('compactionRetention')?.current())
  }

  /** Validate only owned active routes and previously resolved capacities, without network work. */
  private validateRetention(preference: Readonly<RetentionPreference>): void {
    const override = preference.mode === 'tokens' ? { retainTokens: preference.value }
      : preference.mode === 'ratio' ? { retainRatio: preference.value } : {}
    resolveTargetPolicy(this.config, { provider: '', model: '' }, override)
    for (const model of this.config.modelPolicies) resolveTargetPolicy(this.config, model, override)
    const known = new Map(this.knownTargets)
    for (const active of this.ctx.get('agents')?.list() ?? []) {
      if (active.ctx.get('compaction') !== this) continue
      const target = conversationTarget(active)
      const context = active.session.requestContext()
      if (target === undefined || context?.provider !== target.provider
        || context.model !== target.model || context.contextWindow === undefined) continue
      known.set(`${target.provider}\0${target.model}`, { ...target, contextWindow: context.contextWindow, reserve: context.outputReserve ?? active.session.requestHeader()?.config.maxTokens ?? 0 })
    }
    for (const target of known.values()) {
      resolveCompactSpec(resolveTargetPolicy(this.config, target, override), target.contextWindow, target.reserve)
    }
  }

  /** Resolve capacity and reserve together, retaining the route for synchronous Settings validation. */
  private async resolveSpec(
    agent: Agent, policy: ResolvedTargetPolicy, measurement: TokenMeasurement, signal: AbortSignal,
  ): Promise<ResolvedCompactSpec> {
    const target = policy.target
    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
    if (info.context === undefined) throw new TargetPressureConfigError(`${target.provider}/${target.model}`, `compaction-basic: no context capacity for ${target.provider}/${target.model}; configure contextWindow on that adapter model`)
    const reserve = reservedCompletionTokens(agent, info.defaultMaxTokens, measurement.outputReserveTokens)
    this.knownTargets.set(`${target.provider}\0${target.model}`, { ...target, contextWindow: info.context.contextWindow, reserve })
    return resolveCompactSpec(policy, info.context.contextWindow, reserve)
  }

  /** Changed-only policy facts; price arrays are retained only when freshly captured. */
  private policyContext(
    session: Session, policy: ResolvedTargetPolicy, spec: ResolvedCompactSpec, captured?: RequestContext,
  ): RequestContext | undefined {
    const previous = session.requestContext()
    const { replayPrices: _replay, projectionPrices: _projection, ...base } = previous ?? { ...policy.target }
    const retention = { retainTokens: spec.retainTokens, source: policy.retentionSource,
      ...policy.retainRatio === undefined ? {} : { retainRatio: policy.retainRatio } }
    if (captured === undefined && previous?.provider === policy.target.provider && previous.model === policy.target.model
      && previous.contextWindow === spec.contextWindow && JSON.stringify(previous.retention) === JSON.stringify(retention)) return undefined
    return { ...previous?.provider === policy.target.provider && previous.model === policy.target.model ? base : {},
      ...captured, ...policy.target, contextWindow: spec.contextWindow, retention }
  }

  /** Record policy only inside the actual open turn. */
  private recordPolicy(session: Session, policy: ResolvedTargetPolicy, spec: ResolvedCompactSpec): void {
    const context = this.policyContext(session, policy, spec)
    if (context !== undefined) session.append('request/context', context)
  }

  /** One operation owns one retention snapshot and one bounded summary-call allowance. */
  private async withOperation<T>(
    agent: Agent, policy: ResolvedTargetPolicy, run: (operation: CompactionOperation) => Promise<T>,
  ): Promise<T> {
    const active = this.operations.get(agent)
    if (active !== undefined) return run(active)
    const operation = { policy, remainingCalls: policy.compactionRetries + 1 }
    this.operations.set(agent, operation)
    try { return await run(operation) } finally { this.operations.delete(agent) }
  }

  /** Reject an immovable tail/fixed-input goal before paying for any summary. */
  private assertPossibleGoal(
    measurement: TokenMeasurement, range: { start: SessionSeq; end: SessionSeq },
    spec: ResolvedCompactSpec, headroom: number, target?: number,
  ): number {
    const start = measurement.nodes.findIndex(node => node.seq === range.start)
    const end = measurement.nodes.findIndex(node => node.seq === range.end)
    const selected = measurement.nodes.slice(start, end + 1)
    if (measurement.nodes.some(node => node.quality === 'incomplete')) throw new CompactionBudgetError('compaction cannot safely price selected or retained request history; refresh its adapter metadata or offload unsupported media first')
    const tokens = selected.reduce((sum, node) => sum + node.tokens, 0)
    const framing = this.ctx.tokenMeter.estimateMessage(createUserMessage({ source: { kind: 'user' }, content: frameSummary([{ type: 'text', text: 'x' }]) }))
    // ponytail: declarations stay fixed for goal checks; project prospective tool history if conservative refusal becomes limiting.
    const retained = measurement.nodes.reduce((sum, node, index) => sum + (index < start || index > end ? node.tokens : 0), 0)
    const floor = Math.max(measurement.inputTokens - tokens,
      measurement.toolsTokens + retained + measurement.unattributedTokens) + framing
    if (tokens <= framing) throw new CompactionBudgetError(`compaction cannot reach input target ${target ?? spec.targetTokens}: selected ${tokens} tokens cannot shrink below checkpoint framing ${framing}`)
    if (floor >= spec.thresholdTokens || (target !== undefined && floor > target)) throw new CompactionBudgetError(`compaction cannot reach input target ${target ?? spec.targetTokens}: minimum fixed/retained input plus checkpoint is ${floor} tokens`)
    const relief = Math.min(headroom, Math.floor((spec.thresholdTokens - floor) / 2))
    return target ?? spec.thresholdTokens - Math.max(1, relief)
  }

  /** Condense every original selected node; a first partial chunk is not completion. */
  private async compactChosen(
    start: SessionSeq, end: SessionSeq, agent: Agent, operation: CompactionOperation,
    options: Parameters<typeof compactSurfaceRegion>[5], signal?: AbortSignal,
  ): Promise<CompactionResult> {
    const session = agent.session
    const initial = [...session.surface.nodes]
    const first = initial.indexOf(start)
    const last = initial.indexOf(end)
    if (first < 0 || last < first) {
      return compactSurfaceRegion(this.regionDependencies(operation), session, start, end, agent, options, signal)
    }
    const originals = new Set(initial.slice(first, last + 1))
    if (originals.size === 1) {
      const message = buildSummarizationInput(session, [start]).messages.at(-1)
      if (message?.role === 'user' && isCompactCheckpointSource(message.source)) throw new CompactionBudgetError('compaction: a sole existing checkpoint has no new original history to summarize')
    }
    const { pricing: _initialPricing, ...transaction } = options
    let result: CompactionResult | undefined
    let pricing = options.pricing
    for (;;) {
      signal?.throwIfAborted()
      const remaining = session.surface.nodes.filter(seq => originals.has(seq))
      const chunkEnd = remaining.at(-1)
      if (chunkEnd === undefined) {
        if (result === undefined) throw new CompactionBudgetError('compaction: selected history disappeared before summarization')
        return result
      }
      if (operation.remainingCalls <= 0) throw new CompactionBudgetError(`compaction exhausted ${operation.policy.compactionRetries + 1} summary calls before all selected original history was condensed`)
      const chunkStart = result === undefined ? start : SessionSeq(result.summarySeq + 1)
      const measurement = options.owner === null ? this.ctx.tokenMeter.preview(session).measurement : this.ctx.tokenMeter.refresh(session)
      let chosenEnd = chunkEnd
      let prepared: Awaited<ReturnType<typeof prepareSummarization>> | undefined
      if (this.summarize === BasicCompactionEngine.prototype.summarize) {
        const nodes = session.surface.nodes
        const from = nodes.indexOf(chunkStart)
        const to = nodes.indexOf(chunkEnd)
        const full = buildSummarizationInput(session, nodes.slice(from, to + 1))
        prepared = await prepareSummarization(this.ctx, operation.policy, full, agent, signal)
        const fullTokens = prepared.price(full)
        if (fullTokens + prepared.outputReserve > prepared.contextWindow) {
          const ends = safeCompactionEnds(session, measurement, chunkStart, chunkEnd)
          // ponytail: positional searches are quadratic; cache an index map if prefix preflight becomes a measured bottleneck.
          let unitStart = from
          for (const endpoint of ends) {
            const unitEnd = nodes.indexOf(endpoint)
            const unit = buildSummarizationInput(session, nodes.slice(unitStart, unitEnd + 1))
            if (prepared.price(unit) + prepared.outputReserve > prepared.contextWindow) throw new CompactionBudgetError(`compaction summary: an indivisible tool/cost group cannot fit context ${prepared.contextWindow} with response reserve ${prepared.outputReserve}`)
            unitStart = unitEnd + 1
          }
          let low = 0
          let high = ends.length - 1
          let fitting: SessionSeq | undefined
          while (low <= high) {
            const middle = Math.floor((low + high) / 2)
            const candidate = ends[middle]
            if (candidate === undefined) break
            const input = buildSummarizationInput(session, nodes.slice(from, nodes.indexOf(candidate) + 1))
            if (prepared.price(input) + prepared.outputReserve <= prepared.contextWindow) {
              fitting = candidate
              low = middle + 1
            } else high = middle - 1
          }
          if (fitting === undefined || (result !== undefined && fitting === chunkStart)) throw new CompactionBudgetError(`compaction summary: fixed input or an indivisible tool/cost group cannot fit context ${prepared.contextWindow} with response reserve ${prepared.outputReserve}`)
          chosenEnd = fitting
        }
        const chosen = measurement.nodes.slice(nodes.indexOf(chunkStart), nodes.indexOf(chosenEnd) + 1)
        const minimumCheckpoint = this.ctx.tokenMeter.estimateMessage(createUserMessage({ source: { kind: 'user' }, content: frameSummary([]) }))
        if (chosen.reduce((sum, node) => sum + node.tokens, 0) <= minimumCheckpoint) throw new CompactionBudgetError('compaction summary: no fitting prefix can become smaller after checkpoint framing')
      }
      result = await compactSurfaceRegion(this.regionDependencies(operation, prepared), session, chunkStart, chosenEnd, agent,
        { ...transaction, ...pricing === undefined ? {} : { pricing } }, signal)
      pricing = undefined
      if (options.owner !== null) this.ctx.tokenMeter.refresh(session)
    }
  }

  /** Bind the operation snapshot and count all summary invocations, including recovery. */
  private regionDependencies(
    operation: CompactionOperation, prepared?: Awaited<ReturnType<typeof prepareSummarization>>,
  ): Parameters<typeof compactSurfaceRegion>[0] {
    return {
      meter: this.ctx.tokenMeter,
      summarize: (input, owner, abort) => {
        if (operation.remainingCalls <= 0) throw new CompactionBudgetError('compaction summary-call allowance exhausted during recovery')
        operation.remainingCalls -= 1
        const bound = prepared
        prepared = undefined
        return this.summarize === BasicCompactionEngine.prototype.summarize
          ? bound === undefined ? summarizeWithLlm(this.ctx, operation.policy, input, owner, abort) : bound.summarize(input)
          : this.summarize(input, owner, abort)
      },
      recover: (error, agent, sourceEventSeqs, signal) => this.ctx.waterfall('compaction/summary-error', {
        session: agent.session,
        sourceEventSeqs,
        error,
        ...signal === undefined ? {} : { signal },
      }, () => false),
    }
  }
}

export default BasicCompactionEngine
