/** Current logical Session accounting facts; historical logs may omit every field. */

import type { SessionEvent, SessionLogOffset } from './types.ts'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function price(value: unknown): boolean {
  if (!record(value) || !keys(value, ['messageId', 'replay', 'basis', 'tokens'])
    || !text(value['messageId']) || !['native', 'fallback'].includes(String(value['replay']))) return false
  if (value['basis'] === 'usage-output' || value['basis'] === 'unknown') return value['tokens'] === undefined
  return value['basis'] === 'estimate' && count(value['tokens'])
}

function scope(value: unknown): boolean {
  return record(value) && value['version'] === 1
    && keys(value, ['version', 'adapter', 'projection', 'provider', 'api', 'model'])
    && ['adapter', 'projection', 'provider', 'model'].every(key => text(value[key]))
    && (value['api'] === undefined || text(value['api']))
}

function imagePrice(value: unknown): boolean {
  return record(value) && keys(value, ['visualTokens', 'text']) && count(value['visualTokens']) && typeof value['text'] === 'string'
}

function projectionPrice(value: unknown): boolean {
  return record(value) && keys(value, ['messageId', 'projectedTokens', 'images', 'files']) && text(value['messageId'])
    && (value['projectedTokens'] === undefined || count(value['projectedTokens']))
    && (value['images'] === undefined || Array.isArray(value['images']) && value['images'].every(
      (image: unknown) => record(image) && keys(image, ['retained', 'offloaded']) && imagePrice(image['retained']) && imagePrice(image['offloaded']),
    ))
    && (value['files'] === undefined || Array.isArray(value['files']) && value['files'].every(file => typeof file === 'string'))
}

/**
 * Validate optional current-generation accounting payloads without requiring facts in old logs.
 * @param event - candidate event at append, adoption, or restore.
 * @param subject - diagnostic event location.
 */
export function validateAccountingData(event: { readonly type: string; readonly data: unknown }, subject: string): void {
  const data: unknown = event.data
  if (!record(data)) return
  if (event.type === 'compaction/start' && data['pricing'] !== undefined) {
    const pricing = data['pricing']
    if (!record(pricing) || !text(pricing['provider']) || !text(pricing['model'])
      || pricing['contextWindow'] !== undefined && (!count(pricing['contextWindow']) || pricing['contextWindow'] === 0)) {
      throw new Error(`${subject} invalid maintenance pricing context`)
    }
    validateAccountingData({ type: 'request/context', data: pricing }, `${subject} pricing`)
  }
  if (event.type === 'request/context') {
    if (data['outputReserve'] !== undefined && (!count(data['outputReserve']) || data['outputReserve'] === 0)) {
      throw new Error(`${subject} outputReserve must be a positive safe integer`)
    }
    if (data['replayPricing'] !== undefined && !scope(data['replayPricing'])) throw new Error(`${subject} invalid replayPricing`)
    if (data['replayPrices'] !== undefined && (data['replayPricing'] === undefined
      || !Array.isArray(data['replayPrices']) || !data['replayPrices'].every(price))) {
      throw new Error(`${subject} invalid scope-bound replayPrices`)
    }
    if (data['projectionPrices'] !== undefined && (!Array.isArray(data['projectionPrices'])
      || !data['projectionPrices'].every(projectionPrice))) throw new Error(`${subject} invalid projectionPrices`)
    const toolProjection = data['toolProjection']
    if (toolProjection !== undefined && (!record(toolProjection) || !keys(toolProjection, ['tokens', 'mode'])
      || !count(toolProjection['tokens']) || !['none', 'addition-only', 'in-history'].includes(String(toolProjection['mode'])))) {
      throw new Error(`${subject} invalid toolProjection`)
    }
    const retention = data['retention']
    if (retention !== undefined && (!record(retention) || !keys(retention, ['retainTokens', 'retainRatio', 'source'])
      || !count(retention['retainTokens']) || !['model', 'settings', 'config'].includes(String(retention['source']))
      || retention['retainRatio'] !== undefined && (typeof retention['retainRatio'] !== 'number'
        || !Number.isFinite(retention['retainRatio']) || retention['retainRatio'] <= 0 || retention['retainRatio'] > 1))) {
      throw new Error(`${subject} invalid retention policy`)
    }
  }
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return
  const request = data['request']
  if (request !== undefined && (!record(request) || request['version'] !== 1
    || !keys(request, ['version', 'logOffset', 'headerSeq', 'contextSeq'])
    || !count(request['logOffset']) || !count(request['headerSeq']) || !count(request['contextSeq'])
    || request['headerSeq'] >= request['logOffset'] || request['contextSeq'] >= request['logOffset'])) {
    throw new Error(`${subject} invalid request dispatch cut`)
  }
  const hint = data['replayPrice']
  if (hint !== undefined && (event.type !== 'assistant/message' || !record(hint) || !count(hint['contextSeq'])
    || !keys(hint, ['contextSeq', 'price'])
    || !price(hint['price']) || !record(data['message']) || !record(hint['price'])
    || hint['price']['messageId'] !== data['message']['id'])) {
    throw new Error(`${subject} invalid own-message replayPrice`)
  }
}

/**
 * Validate referenced request records when the preceding event window is available.
 * @param event - append or fold candidate.
 * @param events - contiguous event window.
 * @param baseSeq - absolute start of that window.
 */
export function validateAccountingReferences(event: SessionEvent, events: readonly SessionEvent[], baseSeq: SessionLogOffset): void {
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return
  const request = event.data.request
  if (request !== undefined) {
    if (request.logOffset > event.seq) throw new Error('request dispatch cut must not follow settlement')
    for (const [seq, type] of [[request.headerSeq, 'request/header'], [request.contextSeq, 'request/context']] as const) {
      if (seq >= baseSeq && events[seq - baseSeq]?.type !== type) throw new Error(`request dispatch must reference ${type}`)
    }
  }
  if (event.type !== 'assistant/message' || event.data.replayPrice === undefined) return
  const hint = event.data.replayPrice
  if (request !== undefined && hint.contextSeq !== request.contextSeq) throw new Error('replayPrice must use its dispatched context')
  const context = events[hint.contextSeq - baseSeq]
  if (hint.contextSeq >= event.seq || hint.contextSeq >= baseSeq
    && (context?.type !== 'request/context' || context.data.replayPricing === undefined)) {
    throw new Error('replayPrice must reference an earlier pricing request/context')
  }
}
