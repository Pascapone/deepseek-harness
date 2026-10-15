/** Native replay eligibility uses the same durable conversion and pi-ai transform as dispatch. */

import { createHash } from 'node:crypto'
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages'
import { adjustMaxTokensForThinking } from '@earendil-works/pi-ai/api/simple-options'
import type { Api, Model, ModelThinkingLevel, SimpleStreamOptions } from '@earendil-works/pi-ai'
import type { LlmReplayPrice, LlmReplayRequestPricing } from '@deepseek-ai/dsh-llm'
import { toPiAssistant } from './replay.ts'

/**
 * Reserve pi-ai's response ceiling before its input-dependent context clamp.
 * Unknown protocols and protocols ignoring caller caps use the native ceiling conservatively.
 * @param model - captured native model descriptor.
 * @param maxTokens - effective caller cap, if configured.
 * @param reasoning - validated native thinking level.
 * @param thinkingBudgets - captured provider thinking budgets.
 * @returns response reserve, not an assertion of the final wire cap.
 */
export function piOutputReserve(
  model: Model<Api>, maxTokens: number | undefined, reasoning: ModelThinkingLevel | undefined,
  thinkingBudgets: SimpleStreamOptions['thinkingBudgets'],
): number {
  const cap = maxTokens ?? model.maxTokens
  const thinking = reasoning !== undefined && reasoning !== 'off'
  const adaptive = model.compat !== undefined && 'forceAdaptiveThinking' in model.compat &&  model.compat.forceAdaptiveThinking
  const omitsCap = model.compat !== undefined && 'supportsMaxOutputTokens' in model.compat && ! model.compat.supportsMaxOutputTokens
  switch (model.api) {
    case 'anthropic-messages':
      return thinking && !adaptive
        ? adjustMaxTokensForThinking(cap, model.maxTokens, reasoning, thinkingBudgets).maxTokens : cap
    case 'bedrock-converse-stream': return thinking ? model.maxTokens : cap
    case 'openai-responses': return omitsCap ? model.maxTokens : Math.max(16, cap)
    case 'azure-openai-responses': return Math.max(16, cap)
    case 'openai-completions':
    case 'google-generative-ai':
    case 'google-vertex':
    case 'mistral-conversations':
    case 'pi-messages': return cap
    default: return model.maxTokens
  }
}

/**
 * Capture an immutable native-model replay projection without credentials or I/O.
 * @param model - exact model descriptor passed to pi-ai's stream.
 * @returns eligibility facts; output usage is a hint, never an exact future replay count.
 */
export function piReplayRequestPricing(model: Model<Api>): LlmReplayRequestPricing {
  const nativeModel = structuredClone(model)
  const projection = createHash('sha256').update(JSON.stringify({
    api: model.api, provider: model.provider, model: model.id,
    compat: model.compat, input: model.input, baseUrl: model.baseUrl,
  })).digest('hex')
  return {
    scope: {
      version: 1, adapter: 'pi-ai', projection: `pi-ai-0.87.1/replay-v2/hint-v1:${projection}`,
      provider: model.provider, api: model.api, model: model.id,
    },
    priceMessages(messages) {
      return messages.flatMap((message): LlmReplayPrice[] => {
        if (message.role !== 'assistant') return []
        const assistant = toPiAssistant(message)
        const projected = transformMessages([assistant], nativeModel).find(value => value.role === 'assistant')
        if (projected === undefined) {
          return [{ messageId: message.id, replay: 'fallback', basis: 'estimate', tokens: 0 }]
        }
        const native = assistant.provider === nativeModel.provider
          && assistant.api === nativeModel.api && assistant.model === nativeModel.id
        return [{ messageId: message.id, replay: native ? 'native' : 'fallback', basis: native ? 'usage-output' : 'unknown' }]
      })
    },
  }
}
