/** Pure request-cut accounting shared by host measurement and client projections. */
import { z } from 'zod'
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm'
import type { LlmReplayPrice, TokenUsage } from '@deepseek-ai/dsh-llm'
import { canonicalHeader, deriveEventMessage, isSurfaceEvent, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { EpochHeader, SessionEvent } from '@deepseek-ai/dsh-session'
import { estimateContent, estimateToolsTokens } from './estimate.ts'
import { planSurfaceTokens } from './surface-fold.ts'
import { foldSurfaceProjection } from './surface-projection.ts'
import type { TokenMeasurement, TokenMeasurementQuality } from './types.ts'

const count = z.number().int().nonnegative()
const seq = count.max(Number.MAX_SAFE_INTEGER).transform(SessionSeq)
const offset = count.max(Number.MAX_SAFE_INTEGER).transform(SessionLogOffset)
const quality = z.enum(['observed', 'usage-supported', 'estimated', 'incomplete'])
const toolMode = z.enum(['none', 'addition-only', 'in-history'])
const priceSchema = z.object({
  scope: z.string(), replay: z.enum(['native', 'fallback']),
  basis: z.enum(['usage-output', 'estimate', 'unknown']), tokens: count.optional(),
})
const imagePriceSchema = z.object({ visualTokens: count, text: z.string() })
const projectionPriceSchema = z.object({
  scope: z.string(),
  projectedTokens: count.optional(), toolMode: toolMode.optional(),
  images: z.array(z.object({ retained: imagePriceSchema, offloaded: imagePriceSchema })).optional(),
  files: z.array(z.string()).optional(),
})
const nodeSchema = z.object({
  seq, messageId: z.string().optional(), heuristicTokens: count, system: z.boolean(), developer: z.boolean(),
  hasReplay: z.boolean(), outputTokens: count.optional(),
  images: z.array(z.boolean()), imageStructuralTokens: count, fileStructuralTokens: count, fileCount: count,
  replayPrice: priceSchema.optional(),
  projectionPrice: projectionPriceSchema.optional(),
})
const frameSchema = z.object({
  headerKey: z.string(), provider: z.string(), model: z.string(), toolsTokens: count,
  toolsHeaderKey: z.string(),
  toolProjection: z.object({
    scope: z.string(), headerKey: z.string(), headerSeq: seq.optional(), tokens: count, mode: toolMode,
  }).optional(),
  headerSeq: seq.optional(), contextSeq: seq.optional(), scope: z.string(), pricingRevision: count,
  contextWindow: count.positive().optional(), outputReserveTokens: count.optional(),
  requestedMaxTokens: count.optional(),
  retention: z.object({ retainTokens: count, retainRatio: z.number().nonnegative().max(1).optional(), source: z.enum(['model', 'settings', 'config']) }).optional(),
})
const pricedNodeSchema = z.object({ seq, tokens: count })
const groupSchema = z.object({ seqs: z.array(seq), tokens: count, quality })
const observationSchema = z.object({
  tokens: count, logOffset: offset, headerSeq: seq.optional(), contextSeq: seq.optional(),
  usage: z.object({
    inputTokens: count, outputTokens: count, cacheReadTokens: count.optional(), cacheWriteTokens: count.optional(),
    reasoningTokens: count.optional(), totalTokens: count.optional(),
  }).transform(value => ({
    inputTokens: value.inputTokens, outputTokens: value.outputTokens,
    ...value.cacheReadTokens === undefined ? {} : { cacheReadTokens: value.cacheReadTokens },
    ...value.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: value.cacheWriteTokens },
    ...value.reasoningTokens === undefined ? {} : { reasoningTokens: value.reasoningTokens },
    ...value.totalTokens === undefined ? {} : { totalTokens: value.totalTokens },
  })),
  frame: frameSchema, nodes: z.array(pricedNodeSchema), exactCut: z.boolean(),
})
const changeSchema = z.object({
  seq, frame: frameSchema,
  groups: z.array(groupSchema),
  // A sparse undo journal retains removed compact prices, never message/replay bodies.
  start: count.optional(), added: count.optional(), removed: z.array(nodeSchema).optional(),
})
/** JSON-only accounting checkpoint; no adapter functions or native payloads. */
export const accountingStateSchema = z.object({
  logRevision: offset, turnOpen: z.boolean(), frame: frameSchema, nodes: z.array(nodeSchema),
  observation: observationSchema.optional(), groups: z.array(groupSchema),
  claim: z.object({ start: seq, end: seq, tokens: count }).optional(),
  step: z.object({ turn: count, step: count, startedAt: seq, changes: z.array(changeSchema) }).optional(),
})
/** Compact durable accounting state. */
export type AccountingState = z.infer<typeof accountingStateSchema>
type Node = z.infer<typeof nodeSchema>
type Frame = z.infer<typeof frameSchema>
type Observation = z.infer<typeof observationSchema>

/** Create an empty accounting state.
 * @returns initial JSON-only state.
 */
export function initAccounting(): AccountingState {
  return { logRevision: SessionLogOffset(0), turnOpen: false, frame: { headerKey: '', provider: '', model: '', toolsTokens: 0, toolsHeaderKey: '[]', scope: '', pricingRevision: 0 }, nodes: [], groups: [] }
}
/** Canonical identity for stored pricing scopes.
 * @param value - JSON pricing identity.
 * @returns stable identity for the declared field order.
 */
export function pricingScopeKey(value: {
  version: number
  adapter: string
  projection: string
  provider: string
  api?: string
  model: string
} | undefined): string {
  return value === undefined ? '' : JSON.stringify([value.version, value.adapter, value.projection, value.provider, value.api ?? null, value.model])
}
function routeKey(frame: Frame): string {
  return JSON.stringify([frame.provider, frame.model, frame.scope])
}
function toolProjectionKnown(frame: Frame): boolean {
  const tools = frame.toolProjection
  return tools !== undefined && tools.scope === routeKey(frame)
    && tools.headerKey === frame.toolsHeaderKey && tools.headerSeq === frame.headerSeq
}
function nodePrice(node: Node, frame: Frame): { tokens: number; quality: TokenMeasurementQuality } {
  const toolProjection = frame.toolProjection
  const toolKnown = toolProjectionKnown(frame)
  if (node.developer) {
    const receipt = node.projectionPrice
    return toolKnown && receipt?.scope === routeKey(frame)
      && receipt.toolMode === toolProjection?.mode && receipt.projectedTokens !== undefined
      ? { tokens: receipt.projectedTokens, quality: 'estimated' } : { tokens: node.heuristicTokens, quality: 'incomplete' }
  }
  const price = node.replayPrice?.scope === frame.scope && frame.scope !== '' ? node.replayPrice : undefined
  if (price?.basis === 'estimate' && price.tokens !== undefined) return { tokens: price.tokens, quality: 'estimated' }
  if (price?.replay === 'native') {
    if (price.basis === 'usage-output' && node.outputTokens !== undefined && node.outputTokens > 0) return { tokens: node.outputTokens, quality: 'usage-supported' }
    return { tokens: node.heuristicTokens, quality: 'incomplete' }
  }
  const projected = node.projectionPrice?.scope === routeKey(frame) ? node.projectionPrice : undefined
  let tokens = node.heuristicTokens
  let missingMedia = false
  if (node.images.length > 0) {
    if (projected?.images?.length !== node.images.length) missingMedia = true
    else {
      tokens -= node.imageStructuralTokens
      for (const [index, offloaded] of node.images.entries()) {
        const price = projected.images[index]
        if (price === undefined) continue
        const image = offloaded ? price.offloaded : price.retained
        tokens += image.visualTokens + estimateContent([{ type: 'text', text: image.text }])
      }
    }
  }
  if (node.fileCount > 0) {
    if (projected?.files?.length !== node.fileCount) missingMedia = true
    else {
      tokens -= node.fileStructuralTokens
      for (const text of projected.files) tokens += estimateContent([{ type: 'text', text }])
    }
  }
  return {
    tokens,
    quality: (node.hasReplay && price === undefined) || missingMedia ? 'incomplete' : 'estimated',
  }
}
function priceNodes(nodes: readonly Node[], frame: Frame, groups: AccountingState['groups']) {
  const priced: {
    seq: SessionSeq
    heuristicTokens: number
    tokens: number
    quality: TokenMeasurementQuality
    costGroupStartSeq?: SessionSeq
    costGroupEndSeq?: SessionSeq
  }[] = nodes.map(node => ({ seq: node.seq, heuristicTokens: node.heuristicTokens, ...nodePrice(node, frame) }))
  const bySeq = new Map(priced.map(node => [node.seq, node]))
  for (const group of groups) {
    if (!group.seqs.every(id => bySeq.has(id))) continue
    const total = group.seqs.reduce((sum, id) => sum + (bySeq.get(id)?.tokens ?? 0), 0)
    let assigned = 0
    for (const [index, id] of group.seqs.entries()) {
      const node = bySeq.get(id)
      if (node === undefined) continue
      const tokens = index === group.seqs.length - 1 ? group.tokens - assigned
        : total === 0 ? Math.floor(group.tokens / group.seqs.length) : Math.floor(group.tokens * node.tokens / total)
      assigned += tokens
      node.tokens = tokens
      const first = group.seqs[0]
      const last = group.seqs.at(-1)
      if (first !== undefined && last !== undefined) {
        node.costGroupStartSeq = first
        node.costGroupEndSeq = last
      }
      // Only the whole group is usage-supported; this finer split remains estimated.
      node.quality = group.quality === 'incomplete' ? 'incomplete' : 'estimated'
    }
  }
  return priced
}
function promptTokens(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}
function putPrice(nodes: Node[], scope: string, price: LlmReplayPrice, indices?: ReadonlyMap<string | undefined, number>): void {
  const index = indices === undefined ? nodes.findIndex(node => node.messageId === price.messageId) : indices.get(price.messageId) ?? -1
  const node = nodes[index]
  if (node === undefined) return
  nodes[index] = { ...node, replayPrice: {
    scope, replay: price.replay, basis: price.basis, ...price.tokens === undefined ? {} : { tokens: price.tokens },
  } }
}
function sameFrame(left: Frame, right: Frame): boolean {
  return left.headerKey === right.headerKey && routeKey(left) === routeKey(right) && left.pricingRevision === right.pricingRevision
}
function cutAt(state: AccountingState, logOffset: number): { frame: Frame; nodes: Node[]; groups: AccountingState['groups']; exact: boolean } {
  let frame = state.frame
  let groups = state.groups
  const nodes = [...state.nodes]
  if (state.step === undefined) return { frame, nodes, groups, exact: false }
  for (const change of state.step.changes.toReversed()) {
    if (change.seq < logOffset) break
    frame = change.frame
    groups = change.groups
    if (change.start !== undefined) nodes.splice(change.start, change.added ?? 0, ...(change.removed ?? []))
  }
  return { frame, nodes, groups, exact: logOffset > state.step.startedAt }
}

/** Fold committed events without consulting runtime services.
 * @param state - previous compact state.
 * @param event - next committed session event.
 * @returns allocation-fresh state for relevant events, otherwise the previous state.
 */
export function foldAccounting(state: AccountingState, event: SessionEvent): AccountingState {
  const shadow = foldSurfaceProjection(state.claim, event)
  const pricingData = event.type === 'request/context' ? event.data : event.type === 'compaction/start' ? event.data.pricing : undefined
  if (event.type === 'turn/start' || event.type === 'turn/end') {
    const { claim: _expired, ...rest } = state
    return { ...rest, logRevision: SessionLogOffset(event.seq + 1), turnOpen: event.type === 'turn/start' }
  }
  if (!isSurfaceEvent(event) && event.type !== 'request/header' && pricingData === undefined
    && event.type !== 'step/start' && event.type !== 'step/end' && event.type !== 'assistant/attempt'
    && event.type !== 'image/offload') {
    if (state.claim === undefined && shadow.claim === undefined) return state
    const { claim: _expired, ...rest } = state
    return { ...rest, ...shadow.claim === undefined ? {} : { claim: shadow.claim } }
  }
  let frame = state.frame
  let nodes = state.nodes
  let observation = state.observation
  let groups = state.groups
  let step = state.step
  let change: z.infer<typeof changeSchema> | undefined
  if (event.type === 'step/start') {
    if (step !== undefined) throw new Error(`token meter: step/start at seq ${event.seq} arrived before turn ${step.turn}/step ${step.step} ended`)
    step = { ...event.data, startedAt: event.seq, changes: [] }
  } else if (event.type === 'step/end') {
    if (step === undefined || step.turn !== event.data.turn || step.step !== event.data.step) throw new Error(`token meter: step/end at seq ${event.seq} has no matching step/start event`)
    step = undefined
  } else if (event.type === 'request/header') {
    const header = canonicalHeader(event.data.header)
    const sameRoute = frame.provider === header.config.provider && frame.model === header.config.model
    const sameLimit = frame.requestedMaxTokens === header.config.maxTokens
    frame = { ...frame, headerKey: JSON.stringify(header), provider: header.config.provider, model: header.config.model,
      toolsTokens: estimateToolsTokens(header), headerSeq: event.seq,
      toolsHeaderKey: JSON.stringify(header.tools ?? []),
      requestedMaxTokens: header.config.maxTokens,
      ...sameLimit ? {} : { outputReserveTokens: undefined },
      ...sameRoute ? {} : { scope: '', contextSeq: undefined, contextWindow: undefined, outputReserveTokens: undefined, retention: undefined } }
    change = { seq: event.seq, frame: state.frame, groups: state.groups }
    if (!sameRoute) groups = []
  } else if (pricingData !== undefined) {
    const data = pricingData
    {
      const scope = pricingScopeKey(data.replayPricing)
      frame = { ...frame, provider: data.provider, model: data.model, contextSeq: event.seq, scope,
        contextWindow: data.contextWindow, outputReserveTokens: data.outputReserve, retention: data.retention }
      if (data.toolProjection !== undefined) frame = { ...frame, toolsTokens: data.toolProjection.tokens,
        toolProjection: { ...data.toolProjection, scope: routeKey(frame), headerKey: frame.toolsHeaderKey, headerSeq: frame.headerSeq } }
      if (scope !== state.frame.scope) groups = []
      nodes = [...nodes]
      const indices = new Map(nodes.map((node, index) => [node.messageId, index]))
      for (const price of data.replayPrices ?? []) putPrice(nodes, scope, price, indices)
      for (const price of data.projectionPrices ?? []) {
        const index = indices.get(price.messageId) ?? -1
        const node = nodes[index]
        if (node !== undefined) nodes[index] = { ...node, projectionPrice: { scope: routeKey(frame),
          ...price.projectedTokens === undefined ? {} : {
            projectedTokens: price.projectedTokens, toolMode: data.toolProjection?.mode ?? frame.toolProjection?.mode,
          },
          ...price.images === undefined ? {} : {
            images: price.images.map(image => ({ retained: { ...image.retained }, offloaded: { ...image.offloaded } })),
          },
          ...price.files === undefined ? {} : { files: [...price.files] } } }
      }
      const anchored = new Set(observation?.nodes.map(node => node.seq))
      const active = new Set(nodes.map(node => node.seq))
      const observed = observation
      const firstTools = data.toolProjection !== undefined && observed !== undefined && !toolProjectionKnown(observed.frame)
        && observed.frame.toolsHeaderKey === frame.toolsHeaderKey && observed.nodes.every(node => active.has(node.seq))
        && nodes.every(node => !node.developer || node.seq < observed.logOffset)
      const repriced = (data.toolProjection !== undefined && observation !== undefined && toolProjectionKnown(observation.frame)
        && (observation.frame.toolsTokens !== data.toolProjection.tokens
          || observation.frame.toolProjection?.mode !== data.toolProjection.mode)) || nodes.some((node, index) => anchored.has(node.seq)
        && nodePrice(state.nodes[index] ?? node, state.frame).quality !== 'incomplete'
        && nodePrice(node, frame).tokens !== nodePrice(state.nodes[index] ?? node, state.frame).tokens)
      if (repriced) {
        frame = { ...frame, pricingRevision: frame.pricingRevision + 1 }
        groups = []
      }
      if (observation !== undefined && observation.frame.provider === frame.provider && observation.frame.model === frame.model) {
        const previousNodes = new Map(state.nodes.map(node => [node.seq, node]))
        const currentNodes = new Map(nodes.map(node => [node.seq, node]))
        const grouped = new Set(state.groups.flatMap(group => group.seqs))
        const anchor = observation.nodes.map((node) => {
          const before = previousNodes.get(node.seq)
          const after = currentNodes.get(node.seq)
          if (before === undefined || after === undefined || grouped.has(node.seq)
            || before.replayPrice?.scope === state.frame.scope && before.replayPrice.replay === 'native') return node
          const price = after.replayPrice
          if (price?.scope === frame.scope && price.replay === 'native' && price.basis === 'usage-output' && after.outputTokens !== undefined) return { seq: node.seq, tokens: after.outputTokens }
          if (before.developer && before.projectionPrice?.projectedTokens === undefined
            && after.projectionPrice?.projectedTokens !== undefined && toolProjectionKnown(frame)) {
            return { seq: node.seq, tokens: after.projectionPrice.projectedTokens }
          }
          let tokens = node.tokens
          const prior = before.projectionPrice?.scope === routeKey(state.frame) ? before.projectionPrice : undefined
          const next = after.projectionPrice?.scope === routeKey(frame) ? after.projectionPrice : undefined
          if (before.images.length > 0 && prior?.images?.length !== before.images.length && next?.images?.length === before.images.length) {
            tokens -= before.imageStructuralTokens
            for (const [index, offloaded] of before.images.entries()) {
              const receipt = next.images[index]
              if (receipt === undefined) continue
              const image = offloaded ? receipt.offloaded : receipt.retained
              tokens += image.visualTokens + estimateContent([{ type: 'text', text: image.text }])
            }
          }
          if (before.fileCount > 0 && prior?.files?.length !== before.fileCount && next?.files?.length === before.fileCount) {
            tokens -= before.fileStructuralTokens
            for (const text of next.files) tokens += estimateContent([{ type: 'text', text }])
          }
          return tokens === node.tokens ? node : { seq: node.seq, tokens }
        })
        const materializing = observation.frame.headerKey === frame.headerKey && ((observation.frame.scope === '' && frame.scope !== '') || firstTools)
        observation = { ...observation, nodes: anchor,
          ...firstTools ? { frame: { ...observation.frame, toolsTokens: frame.toolsTokens, toolProjection: frame.toolProjection } } : {},
          ...materializing ? { frame: { ...observation.frame,
            ...firstTools ? { toolsTokens: frame.toolsTokens, toolProjection: frame.toolProjection } : {},
            scope: frame.scope, pricingRevision: frame.pricingRevision,
          }, exactCut: false } : {} }
      }
      change = { seq: event.seq, frame: state.frame, groups: state.groups, start: 0, added: nodes.length, removed: state.nodes }
    }
  }
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
    const usage = event.type === 'assistant/message' && event.data.usage !== undefined ? event.data.usage : lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
    // Zero-input unsuccessful attempts do not establish a request-input baseline.
    if (usage !== undefined && (event.type !== 'assistant/attempt' || promptTokens(usage) > 0)) {
      const request = event.data.request
      const cut = request === undefined ? { frame, nodes: [...nodes], groups, exact: false }
        : cutAt({ ...state, frame, nodes }, request.logOffset)
      const cutPrices = priceNodes(cut.nodes, cut.frame, cut.groups)
      const nextObservation: Observation = {
        tokens: promptTokens(usage), usage, logOffset: request?.logOffset ?? SessionLogOffset(event.seq),
        ...request === undefined ? {} : { headerSeq: request.headerSeq, contextSeq: request.contextSeq },
        frame: cut.frame, nodes: cutPrices.map(({ seq, tokens }) => ({ seq, tokens })),
        exactCut: cut.exact && (request === undefined
          || (request.headerSeq === cut.frame.headerSeq && request.contextSeq === cut.frame.contextSeq)),
      }
      if (observation !== undefined && observation.tokens > 0 && nextObservation.tokens > 0
        && observation.exactCut && nextObservation.exactCut && sameFrame(observation.frame, cut.frame)) {
        const previous = new Map(observation.nodes.map(node => [node.seq, node.tokens]))
        const current = new Map(cutPrices.map(node => [node.seq, node.tokens]))
        const added = cutPrices.filter(node => !previous.has(node.seq))
        const removed = observation.nodes.filter(node => !current.has(node.seq))
        const unchanged = cutPrices.every(node => !previous.has(node.seq) || previous.get(node.seq) === node.tokens)
        const tokens = nextObservation.tokens - observation.tokens + removed.reduce((sum, node) => sum + node.tokens, 0)
        if (unchanged && added.length > 0 && tokens >= 0) {
          const addedIds = new Set(added.map(node => node.seq))
          groups = [...groups.filter(group => !group.seqs.some(id => addedIds.has(id))), { seqs: added.map(node => node.seq), tokens, quality: removed.length === 0 ? 'usage-supported' : 'estimated' }]
          nextObservation.nodes = priceNodes(cut.nodes, cut.frame, groups).map(({ seq, tokens }) => ({ seq, tokens }))
        }
      }
      observation = nextObservation
    }
  }
  if (isSurfaceEvent(event)) {
    if (event.type === 'assistant/message' && (step === undefined || step.turn !== event.data.turn || step.step !== event.data.step)) throw new Error(`token meter: assistant/message at seq ${event.seq} has no matching step/start event`)
    const plan = planSurfaceTokens(nodes, event)
    const message = deriveEventMessage(event)
    const usage = event.type === 'assistant/message' ? event.data.usage ?? lastAssistantStreamChunk(event.data.stream, 'usage')?.usage : undefined
    const node: Node = {
      seq: event.seq, heuristicTokens: plan.tokens, system: event.type === 'system/message', developer: event.type === 'developer/message',
      ...message === null ? {} : { messageId: message.id },
      hasReplay: message?.role === 'assistant' && message.source.replayState !== undefined,
      images: plan.node.images.map(image => image.offloaded === true), imageStructuralTokens: plan.node.imageStructuralTokens,
      fileStructuralTokens: plan.node.fileStructuralTokens, fileCount: plan.node.files.length,
      ...usage === undefined ? {} : { outputTokens: usage.outputTokens },
    }
    const start = plan.target === 'append' ? nodes.length : plan.target.startIdx
    const removed = plan.target === 'append' ? [] : nodes.slice(plan.target.startIdx, plan.target.endIdx + 1)
    nodes = [...nodes]
    nodes.splice(start, removed.length, node)
    if (event.type === 'assistant/message' && event.data.replayPrice !== undefined) {
      const cut = event.data.request === undefined ? { frame } : cutAt(state, event.data.request.logOffset)
      if (event.data.replayPrice.contextSeq === cut.frame.contextSeq) putPrice(nodes, cut.frame.scope, event.data.replayPrice.price)
    }
    change = { seq: event.seq, frame: state.frame, groups: state.groups, start, added: 1, removed }
    const retained = new Set(nodes.map(node => node.seq))
    groups = groups.flatMap((group) => {
      const seqs = group.seqs.filter(id => retained.has(id))
      if (seqs.length === 0) return []
      // A partial replacement cannot prove which share of a joint observation disappeared.
      return [{ ...group, seqs, quality: seqs.length === group.seqs.length ? group.quality : 'incomplete' as const }]
    })
  }
  if (event.type === 'image/offload') {
    const targets = new Map(event.data.targets.map(target => [target.seq, new Set(target.imageIndexes)]))
    nodes = nodes.map((node) => {
      const indexes = targets.get(node.seq)
      return indexes === undefined ? node : { ...node, images: node.images.map((marked, index) => marked || indexes.has(index)) }
    })
    const deltas = new Map(nodes.map((node, index) => [
      node.seq, nodePrice(node, frame).tokens - nodePrice(state.nodes[index] ?? node, frame).tokens,
    ]))
    groups = groups.map(group => ({ ...group,
      tokens: Math.max(0, group.tokens + group.seqs.reduce((sum, id) => sum + (deltas.get(id) ?? 0), 0)),
      quality: group.quality === 'incomplete' ? 'incomplete' as const : 'estimated' as const,
    }))
    change = { seq: event.seq, frame: state.frame, groups: state.groups, start: 0, added: nodes.length, removed: state.nodes }
  }
  if (step !== undefined && change !== undefined) step = { ...step, changes: [...step.changes, change] }
  return { logRevision: SessionLogOffset(event.seq + 1), turnOpen: state.turnOpen, frame, nodes, groups,
    ...observation === undefined ? {} : { observation }, ...step === undefined ? {} : { step },
    ...shadow.claim === undefined ? {} : { claim: shadow.claim } }
}

/** Calculate the same request-input estimate for every consumer.
 * @param state - durable accounting state.
 * @param header - optional detached envelope override; never invokes an adapter.
 * @returns input-only pressure, attribution, and matched-route capacity.
 */
export function calculateAccounting(state: AccountingState, header?: EpochHeader): TokenMeasurement {
  const envelope = header === undefined ? state.frame : { ...state.frame,
    headerKey: JSON.stringify(canonicalHeader(header)), provider: header.config.provider, model: header.config.model,
    toolsTokens: estimateToolsTokens(header), toolsHeaderKey: JSON.stringify(header.tools ?? []),
  }
  const toolKnown = toolProjectionKnown(envelope)
  const frame = { ...envelope, toolsTokens: toolKnown ? envelope.toolProjection?.tokens ?? envelope.toolsTokens : envelope.toolsTokens }
  const routeMatches = frame.provider === state.frame.provider && frame.model === state.frame.model
  const sameLimit = header === undefined || header.config.maxTokens === state.frame.requestedMaxTokens
  const effective = routeMatches ? { ...frame, ...sameLimit ? {} : { outputReserveTokens: undefined } } : { ...frame, scope: '', contextWindow: undefined, outputReserveTokens: undefined }
  const nodes = priceNodes(state.nodes, effective, routeMatches ? state.groups : [])
  const surfaceTokens = nodes.reduce((sum, node) => sum + node.tokens, 0)
  const pricedTokens = surfaceTokens + effective.toolsTokens
  const observation = state.observation
  const anchorTokens = observation === undefined ? 0
    : observation.frame.toolsTokens + observation.nodes.reduce((sum, node) => sum + node.tokens, 0)
  const retainedIds = new Set(nodes.map(node => node.seq))
  const removedFromAnchor = observation?.nodes.some(node => !retainedIds.has(node.seq)) ?? false
  const negativeAnchorRemoved = observation !== undefined && anchorTokens > observation.tokens && removedFromAnchor
  const reusable = observation !== undefined && sameFrame(observation.frame, effective) && !negativeAnchorRemoved
  const comparableRoute = observation?.frame.provider === effective.provider && observation.frame.model === effective.model
  const residual = reusable || comparableRoute ? Math.max(0, observation.tokens - anchorTokens) : 0
  const inputTokens = reusable ? Math.max(0, observation.tokens + pricedTokens - anchorTokens) : pricedTokens + residual
  const incomplete = (!toolKnown && frame.headerKey !== '') || nodes.some(node => node.quality === 'incomplete') || (!reusable && residual > 0) || (reusable && (!observation.exactCut || (residual > 0 && removedFromAnchor)))
  const unchanged = reusable && observation.nodes.length === nodes.length
    && observation.nodes.every((node, index) => node.seq === nodes[index]?.seq && node.tokens === nodes[index].tokens)
  const measurementQuality: TokenMeasurementQuality = incomplete ? 'incomplete' : unchanged ? 'observed' : reusable ? 'usage-supported' : 'estimated'
  const systemSeq = state.nodes.findLast(node => node.system && node.heuristicTokens > 0)?.seq
  const systemTokens = nodes.find(node => node.seq === systemSeq)?.tokens ?? 0
  const baseline = reusable ? { kind: 'usage' as const, tokens: observation.tokens, usage: observation.usage }
    : pricedTokens === 0 && effective.headerKey === '' ? { kind: 'none' as const, tokens: 0 as const } : { kind: 'estimated' as const, tokens: inputTokens }
  return {
    logRevision: state.logRevision, baseline, surfaceDeltaTokens: reusable ? pricedTokens - anchorTokens : 0,
    totalTokens: inputTokens, inputTokens, surfaceTokens, nodes,
    toolsTokens: effective.toolsTokens, systemTokens, messageTokens: surfaceTokens - systemTokens,
    quality: measurementQuality, unattributedTokens: residual,
    groups: routeMatches ? state.groups : [],
    ...observation === undefined ? {} : { lastObservedPrompt: {
      tokens: observation.tokens, logOffset: observation.logOffset, provider: observation.frame.provider, model: observation.frame.model,
      ...observation.headerSeq === undefined ? {} : { headerSeq: observation.headerSeq },
      ...observation.contextSeq === undefined ? {} : { contextSeq: observation.contextSeq },
    } },
    ...effective.contextWindow === undefined ? {} : { contextWindow: effective.contextWindow },
    ...effective.outputReserveTokens === undefined ? {} : { outputReserveTokens: effective.outputReserveTokens },
    ...effective.contextWindow === undefined || effective.outputReserveTokens === undefined ? {} : {
      availableTokens: effective.contextWindow - effective.outputReserveTokens - inputTokens,
    },
  }
}
