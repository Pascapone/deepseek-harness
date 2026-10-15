/** Browser carrier availability configured by the hosting profile. */
import z from '@deepseek-ai/schemastery'

/** Registration policy; native Guest permissions are independent of this option. */
export interface Config {
  /** Omit browser tabs and shortcuts when the supported Desktop bridge is unavailable. */
  requireDesktopBridge: boolean
}

/** Preserve the Web/iframe fallback unless the profile explicitly requires Desktop. */
export const Config: z<{ requireDesktopBridge?: boolean }, Config> = z.object({
  requireDesktopBridge: z.boolean().default(false),
})
