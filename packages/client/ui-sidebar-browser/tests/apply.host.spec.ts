/** Host configuration validation and page-injection lifecycle. */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { expect, it, onTestFinished } from 'vitest'
import { apply, Config } from '../src/index.ts'

it('defaults to the native Web fallback and validates explicit Desktop requirements', () => {
  expect(Config({})).toEqual({ requireDesktopBridge: false })
  expect(Config({ requireDesktopBridge: true })).toEqual({ requireDesktopBridge: true })
  for (const requireDesktopBridge of ['true', 1, {}]) {
    const input: unknown = { requireDesktopBridge }
    expect(() => z.resolve(input, Config, {})).toThrow()
  }
})

it('publishes the resolved configuration and removes its listener on unload', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const fiber = ctx.plugin({ apply, Config }, { requireDesktopBridge: true })
  await fiber.await()
  const rows: { kind: 'global'; name: string; value: unknown }[] = []
  await ctx.parallel('webserver/index-inject', rows)
  expect(rows).toEqual([{ kind: 'global', name: '__DSH_SIDEBAR_BROWSER_CONFIG__', value: { requireDesktopBridge: true } }])
  await fiber.dispose()
  rows.length = 0
  await ctx.parallel('webserver/index-inject', rows)
  expect(rows).toEqual([])
})
