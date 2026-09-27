/** Default model references remain live without a settings service. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import DefaultModel from '../src/index.ts'
import { createScope } from '@deepseek-ai/dsh-scope'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

it('reads complete selections from volatile config and clears omitted reasoning effort', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const live = await liveConfig(ctx, DefaultModel, { provider: 'p', model: 'm' })
  const consumer = ctx.agentDefaultModel
  await live.update({ provider: 'q', model: 'n', reasoningEffort: 'high' })
  expect(consumer.currentSelection()).toEqual({ provider: 'q', model: 'n', reasoningEffort: 'high' })
  await live.replace({ provider: 'p', model: 'm' })
  expect(consumer.currentSelection()).toEqual({ provider: 'p', model: 'm' })
  await consumer.saveSelection({ provider: 'unsaved', model: 'unsaved' })
  expect(consumer.currentSelection()).toEqual({ provider: 'p', model: 'm' })
})

it('inherits scoped defaults, rejects duplicates, and removes contributions without changing the profile', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await liveConfig(ctx, DefaultModel, { provider: 'global', model: 'original' })
  const consumer = ctx.inject(['agentDefaultModel'], () => {})
  await consumer
  const parentKey = {}, childKey = {}
  const parent = createScope(consumer.ctx, parentKey)
  const child = createScope(consumer.ctx, childKey, { parent: parentKey })
  const selected = { provider: 'preset', model: 'chosen', privateMetadata: 'not a model-selection field' }
  expect(() => ctx.agentDefaultModel.registerScoped(selected)).toThrow('require a scope')
  parent.ctx.agentDefaultModel.registerScoped(selected)
  selected.model = 'mutated'
  expect(parent.ctx.agentDefaultModel.currentSelection().model).toBe('chosen')
  expect(ctx.agentDefaultModel.currentSelection(childKey)).toEqual({ provider: 'preset', model: 'chosen' })
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('original')
  expect(ctx.agentDefaultModel.currentSelection({}).model).toBe('original')
  expect(() => parent.ctx.agentDefaultModel.registerScoped(selected)).toThrow('already registered')
  child.ctx.agentDefaultModel.registerScoped({ provider: 'child', model: 'override' })
  const detached = ctx.agentDefaultModel.currentSelection(childKey)
  detached.model = 'mutated'
  expect(ctx.agentDefaultModel.currentSelection(childKey).model).toBe('override')
  await child.dispose()
  expect(ctx.agentDefaultModel.currentSelection(childKey).model).toBe('chosen')
  await parent.dispose()
  expect(ctx.agentDefaultModel.currentSelection(childKey).model).toBe('original')
})

it('persists complete selections through its owning profile entry', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ReasoningEffortId } = await import('@deepseek-ai/dsh-llm')
  const { ctx } = await configurationFixture({ hmr: false })
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'next', reasoningEffort: ReasoningEffortId('high') })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'next', reasoningEffort: 'high' })
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'final' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'final' })
  const standalone = new Context()
  onTestFinished(() => standalone.fiber.dispose())
  await standalone.plugin(DefaultModel, { provider: 'test', model: 'original' })
  await standalone.agentDefaultModel.saveSelection({ provider: 'test', model: 'ignored' })
  expect(standalone.agentDefaultModel.currentSelection().model).toBe('original')
})

it('serializes overlapping saves and continues after a rejected write', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ctx } = await configurationFixture({ hmr: false })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const editor = ctx.configEditor
  const edit = editor.edit.bind(editor)
  const calls: string[] = []
  const intercepted = vi.spyOn(editor, 'edit').mockImplementationOnce(async () => {
    calls.push('rejected')
    entered.resolve(undefined)
    await release.promise
    throw new Error('read-only document')
  }).mockImplementation(async (entry, change) => {
    calls.push('saved')
    await edit(entry, change)
  })
  const first = ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'rejected' })
  const failed = expect(first).rejects.toThrow('read-only document')
  const lastSelection = { provider: 'test', model: 'final' }
  const last = ctx.agentDefaultModel.saveSelection(lastSelection)
  onTestFinished(async () => {
    release.resolve(undefined)
    await Promise.allSettled([failed, last])
    intercepted.mockRestore()
  })
  lastSelection.model = 'mutated'
  await entered.promise
  expect(calls).toEqual(['rejected'])
  release.resolve(undefined)
  await failed
  await last
  expect(calls).toEqual(['rejected', 'saved'])
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'final' })
})
