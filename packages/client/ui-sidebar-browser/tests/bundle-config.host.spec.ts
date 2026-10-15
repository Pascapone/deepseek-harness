/** Optional composition with the external Electron bundle through the real Loader. */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { expect, it, onTestFinished } from 'vitest'
import * as Browser from '../src/index.ts'

const plugin = process.env.DSH_DESKTOP_BROWSER_PLUGIN

it.skipIf(plugin === undefined)('loads the actual bundle policy, explicit overrides, disable and removal', async () => {
  const native = loadOverlayPatches('native-browser', fileURLToPath(new URL('../../../bundle/web-app/cordis.patch.yml', import.meta.url)))
    .flatMap(patch => patch.insert ?? []).filter(row => row.id === 'ui-sidebar-browser')
  const patches = loadOverlayPatches('electron-browser', join(plugin!, 'cordis.patch.yml'))
    .filter(patch => patch.id === 'ui-sidebar-browser')
  expect(patches).toHaveLength(1)
  const configured = applyEntryPatches(native, patches, (message) => { throw new Error(message) })
  expect(configured[0]!.config).toMatchObject({ requireDesktopBridge: true })
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('profileContext', {
    name: 'desktop', dir: '/profile', patchPath: '/profile/cordis.patch.yml', installAnchor: '/profile/package.json',
    cwd: '/workspace', home: '/home', startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  })
  ctx.baseUrl = 'file:///'
  await ctx.plugin(Loader).await()
  ctx.loader.builtins.browser = Browser
  const publish = async (row: typeof native[number]) => {
    await ctx.loader.root.update([{ ...row, name: 'cordis:browser' }])
    await ctx.loader.await()
    const rows: IndexInjection[] = []
    await ctx.parallel('webserver/index-inject', rows)
    return rows
  }
  const expected = (requireDesktopBridge: boolean) => [{ kind: 'global', name: '__DSH_SIDEBAR_BROWSER_CONFIG__', value: { requireDesktopBridge } }]
  expect(await publish(configured[0]!)).toEqual(expected(true))
  expect(await publish({ ...configured[0]!, config: { requireDesktopBridge: false } })).toEqual(expected(false))
  expect(await publish({ ...configured[0]!, disabled: true })).toEqual([])
  expect(ctx.loader.resolve('ui-sidebar-browser').disabled).toBe(true)
  expect(await publish(native[0]!)).toEqual(expected(false))
  await ctx.loader.root.update([])
  const unloaded: IndexInjection[] = []
  await ctx.parallel('webserver/index-inject', unloaded)
  expect(unloaded).toEqual([])
})
