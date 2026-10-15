/**
 * Default one-shot summarization and durable checkpoint framing.
 *
 * @module @deepseek-ai/dsh-compaction-basic/summarizer
 */

import type { Context } from '@deepseek-ai/cordis'
import { contentHasImage, BlockAssembler, createUserMessage, LlmError, projectToolUpdates } from '@deepseek-ai/dsh-llm'
import { canonicalHeader } from '@deepseek-ai/dsh-session'
import { CompactionBudgetError } from './config.ts'
import { deepEqualJson, deepFreeze } from '@deepseek-ai/dsh-util-values'
import { estimateToolsTokens } from '@deepseek-ai/dsh-token-meter/estimate'
import type {
  ContentBlock, FinishReason, GenerateOptions, Message, RequestMessage, TokenUsage, ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'

interface SummaryConfig {
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
}

/** Tags wrapping the structured summary inside the landed checkpoint node. */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/**
 * The summarization directive, delivered as the FINAL user message after the
 * replayed conversation rather than as a distinct summarizer system prompt.
 * Keeping the conversation's own system prompt, tools, and message prefix in
 * front of it makes the auxiliary call a genuine prefix of the last routed
 * request, so the provider's KV cache is reused instead of invalidated.
 */
const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/** Framing that makes the replacement user message established context. */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/**
 * The replayed conversation surface the summarizer condenses. Reproducing the
 * last routed request's system prompt, tools, and leading messages verbatim
 * lets the auxiliary call reuse the provider's warm prefix cache; the trailing
 * compaction instruction is then the only novel input.
 */
export interface SummarizationInput {
  /** The conversation's tool schemas, reused for prefix-cache alignment; absent when the request carried none. */
  readonly tools?: readonly ToolSchema[]
  /** The derived system head, when present, followed by the shadowed region in surface order. */
  readonly messages: readonly Message[]
}

/** Safe summary content plus the exact auxiliary call envelope recorded with it. */
export type SummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  /** Provider-reported usage for this summarization request. */
  usage?: TokenUsage
} & (
  | {
    /** Complete provider output before the text-only summary projection. */
    rawOutput: ContentBlock[]
    /** Identifies exactly one call through this context's `ctx.llm.stream()`. */
    llmStreamCall: true
  }
  | {
    /** Optional complete output from an unmarked template, remote, or other summarizer. */
    rawOutput?: ContentBlock[]
    /** An unmarked result does not identify a call through this context's LLM seam. */
    llmStreamCall?: never
  }
)

/**
 * Run the default cache-reusing `ctx.llm.stream()` summarization call: replay
 * the conversation prefix, then append the compaction instruction as the final
 * user message so the provider's warm prefix cache is reused.
 * @param ctx - context providing the LLM service.
 * @param config - resolved backend configuration.
 * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
 * @param agent - supplies routed-model history, fallback model, and session id.
 * @param signal - optional cancellation forwarded to the adapter.
 * @returns safe text-only summary blocks and the exact call envelope and output.
 */
export async function summarizeWithLlm(
  ctx: Context,
  config: SummaryConfig,
  input: SummarizationInput,
  agent: Agent,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const prepared = await prepareSummarization(ctx, config, input, agent, signal)
  return prepared.summarize(input)
}

/** Capture one default summary call and price candidate prefixes before paid dispatch.
 * @param ctx - LLM and common token-meter services.
 * @param config - operation-snapshotted summary target and output cap.
 * @param input - original prefix supplying the fixed tool interface.
 * @param agent - conversation owner and durable replay prices.
 * @param signal - cancellation for preparation and dispatch.
 * @returns a bounded prefix price and a single-use prepared summary executor.
 */
export async function prepareSummarization(
  ctx: Context,
  config: SummaryConfig,
  input: SummarizationInput,
  agent: Agent,
  signal?: AbortSignal,
): Promise<{
  contextWindow: number
  outputReserve: number
  price: (prefix: SummarizationInput) => number
  summarize: (prefix: SummarizationInput) => Promise<SummaryResult>
}> {
  const latest = agent.session.requestHeader()?.config
  const configured = config.summarizationProvider.length === 0
    ? undefined
    : { provider: config.summarizationProvider, model: config.summarizationModel }
  const agentTarget = agent.options.provider !== undefined
    && agent.options.provider.length > 0
    && agent.options.model !== undefined
    && agent.options.model.length > 0
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  const target = configured ?? latest ?? agentTarget
  if (target === undefined) {
    throw new Error(
      'no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields',
    )
  }

  const sameTarget = latest?.provider === target.provider && latest.model === target.model
  const prepared = await ctx.llm.prepareCall({
    provider: target.provider,
    model: target.model,
    maxTokens: config.maxTokens,
    ...sameTarget && latest.reasoningEffort !== undefined ? { reasoningEffort: latest.reasoningEffort } : {},
  }, signal)
  const contextWindow = prepared.context?.contextWindow
  const outputReserve = prepared.outputReserve
  if (contextWindow === undefined || outputReserve === undefined) throw new CompactionBudgetError(
    `compaction summary: ${target.provider}/${target.model} has no known context capacity or prepared response reserve`,
  )
  const header = canonicalHeader({ config: prepared.config, ...input.tools === undefined ? {} : { tools: [...input.tools] } })
  const meter = ctx.tokenMeter
  const current = meter.measure(agent.session)
  const projection = meter.preview(agent.session, header, {
    ...prepared.replayPricing === undefined ? {} : { replayRequestPricing: prepared.replayPricing },
    ...prepared.imagePricing === undefined ? {} : { imageRequestPricing: prepared.imagePricing },
    outputReserve,
    toolUpdate: prepared.toolUpdate,
    fileRequestText: ref => ctx.llm.fileRequestText(ref),
  }).measurement
  const prices = new Map<string, { tokens: number; incomplete: boolean; seq: number }>()
  for (const node of projection.nodes) {
    // Current surface ids index the Session log; only its retained events are read.
    // oxlint-disable-next-line typescript/no-deprecated, typescript/no-non-null-assertion
    const message = agent.session.deriveEventMessage(agent.session.eventAt(node.seq)!)
    if (message !== null) prices.set(message.id, { tokens: node.tokens, incomplete: node.quality === 'incomplete', seq: node.seq })
  }
  const instruction = deepFreeze({ role: 'user' as const, content: [{ type: 'text' as const, text: COMPACTION_INSTRUCTION }] })
  const instructionTokens = meter.estimateMessage(createUserMessage({ source: { kind: 'user' }, content: instruction.content }))
  // A subset cannot establish which part of an observed global residual disappeared.
  const previousScope = agent.session.requestContext()?.replayPricing
  const comparablePricing = prepared.replayPricing === undefined ? sameTarget && previousScope === undefined
    : deepEqualJson(previousScope, prepared.replayPricing.scope)
  const residual = comparablePricing && !sameTarget
    ? Math.max(projection.unattributedTokens, current.unattributedTokens) : projection.unattributedTokens
  const toolHistory = agent.session.toolHistory()
  const price = (prefix: SummarizationInput): number => {
    const projected = projectToolUpdates(prefix.messages, prefix.tools, prepared.toolUpdate, toolHistory)
    let tokens = estimateToolsTokens({
      config: prepared.config, ...projected.tools === undefined ? {} : { tools: [...projected.tools] },
    }) + instructionTokens + residual
    const included = new Set<number>()
    for (const message of prefix.messages) {
      const known = prices.get(message.id)
      if (known !== undefined) included.add(known.seq)
    }
    const grouped = new Set<number>()
    for (const group of projection.groups) {
      const count = group.seqs.filter(seq => included.has(seq)).length
      if (count === 0) continue
      if (count !== group.seqs.length || group.quality === 'incomplete') throw new CompactionBudgetError('compaction summary input would split a jointly measured cost group')
      tokens += group.tokens
      for (const seq of group.seqs) grouped.add(seq)
    }
    for (const message of projected.messages) {
      const known = 'id' in message ? prices.get(message.id) : undefined
      if (known !== undefined && grouped.has(known.seq)) continue
      const opaque = message.role === 'assistant' && message.source.replayState !== undefined
      if (known?.incomplete || (known === undefined && (opaque || message.content.some(block => block.type === 'image' || block.type === 'file')))) {
        throw new CompactionBudgetError('compaction summary input has unpriced native or media content; refresh pricing or offload the indivisible unit before summarizing')
      }
      tokens += known?.tokens ?? meter.estimateMessage(message.role === 'user' ? createUserMessage({ source: { kind: 'user' }, content: message.content }) : message)
    }
    return tokens
  }
  return {
    price, contextWindow, outputReserve,
    async summarize(prefix: SummarizationInput): Promise<SummaryResult> {
      const inputTokens = price(prefix)
      if (inputTokens + outputReserve > contextWindow) throw new CompactionBudgetError(
        `compaction summary input ${inputTokens} plus prepared output reserve ${outputReserve} exceeds ${target.provider}/${target.model} context ${contextWindow}`,
      )
      const messages: RequestMessage[] = [...prefix.messages, instruction]
      const options: GenerateOptions = {
        ...prepared.config, messages,
        toolHistory,
        ...prefix.tools === undefined ? {} : { tools: [...prefix.tools] },
        sessionId: agent.session.id, purpose: 'compaction',
        ...signal === undefined ? {} : { signal },
      }
      const assembler = new BlockAssembler()
      for await (const chunk of prepared.stream(options)) assembler.push(chunk)
      const error = finishError(assembler.finish)
      if (error !== undefined) throw error
      const rawOutput = assembler.blocks()
      const summary = summaryText(rawOutput)
      if (!summary.some(block => block.text.trim().length > 0)) throw new Error('summarization produced no text summary content')
      return { summary, rawOutput, llmStreamCall: true, provider: options.provider, model: options.model,
        maxTokens: prepared.config.maxTokens ?? config.maxTokens,
        ...assembler.usage === undefined ? {} : { usage: assembler.usage } }
    },
  }
}

/**
 * Wrap raw summary blocks in the durable checkpoint framing.
 * @param summary - safe text-only model output.
 * @returns content for the synthesized replacement user message.
 */
export function frameSummary(summary: readonly ContentBlock[]): ContentBlock[] {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
}

/** Map a terminal summarization finish to its fail-closed error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      return new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/** Reject visual output and keep only text before synthesizing a user message. */
function summaryText(
  blocks: readonly ContentBlock[],
): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
}
