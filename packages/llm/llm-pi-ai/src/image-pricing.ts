/** Request-image estimates and text projections bound to one pi-ai route. */
import { estimateTextAndImageContentTokens } from '@earendil-works/pi-ai/utils/estimate'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import { offloadedImageText, requestImageHandleText, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentAccessResolver, LlmImageRequestPricing } from '@deepseek-ai/dsh-llm'

/**
 * Price the image representation used by pi-ai without reading attachment bytes.
 * Visual costs use the pinned pi-ai estimator, not an exact provider token count.
 * @param supportsImages - captured native model's image capability.
 * @param maxPixels - captured route's deterministic request-image pixel budget.
 * @param resolveAccess - execution-world path resolution shared with dispatch.
 * @returns per-occurrence visual estimates and actual handle/placeholder text.
 */
export function piImageRequestPricing(
  supportsImages: boolean, maxPixels: number, resolveAccess: ImageAttachmentAccessResolver,
): LlmImageRequestPricing {
  return { priceImages: images => images.map(({ attachment: ref, offloaded }) => {
    if (!supportsImages) return { visualTokens: 0, text: textOnlyImageText(ref) }
    const access = resolveAccess(ref)
    if (offloaded === true) return { visualTokens: 0, text: offloadedImageText(ref, access) }
    return {
      visualTokens: estimateTextAndImageContentTokens([{ type: 'image', data: '', mimeType: ref.mediaType }]),
      text: requestImageHandleText(ref, requestImageDimensions(ref.width, ref.height, maxPixels), access),
    }
  }) }
}
