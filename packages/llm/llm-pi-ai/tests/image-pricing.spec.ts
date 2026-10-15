import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { offloadedImageText, requestImageHandleText, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import { piImageRequestPricing } from '../src/image-pricing.ts'

const attachment: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png',
  width: 2048, height: 1024, bytes: 100,
}
const image = { type: 'image' as const, attachment }

describe('pi image request pricing', () => {
  it('prices repeated retained and offloaded occurrences separately without reading bytes', () => {
    const pricing = piImageRequestPricing(true, 524288, () => undefined)
    const prices = pricing.priceImages([image, { ...image, offloaded: true }, image])
    expect(prices[0]).toEqual({ visualTokens: 1200, text: requestImageHandleText(attachment, { width: 1024, height: 512 }) })
    expect(prices[1]).toEqual({ visualTokens: 0, text: offloadedImageText(attachment) })
    expect(prices[2]).toEqual(prices[0])
    expect(pricing.priceImages([])).toEqual([])
  })

  it('prices the text-only projection without resolving attachment access', () => {
    const pricing = piImageRequestPricing(false, 524288, () => { throw new Error('unused access') })
    expect(pricing.priceImages([image, { ...image, offloaded: true }])).toEqual([
      { visualTokens: 0, text: textOnlyImageText(attachment) },
      { visualTokens: 0, text: textOnlyImageText(attachment) },
    ])
  })
})
