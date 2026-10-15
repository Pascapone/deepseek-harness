/** Host companion for the Sidebar Browser Client plugin. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Config } from './config.ts'

export { Config } from './config.ts'

/**
 * Publish the validated profile policy to each newly loaded Client.
 * @param ctx - Host context serving browser pages.
 * @param config - Browser registration policy; changing it requires a Client reload.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('webserver/index-inject', (rows) => {
    rows.push({ kind: 'global', name: '__DSH_SIDEBAR_BROWSER_CONFIG__', value: config })
  })
}
