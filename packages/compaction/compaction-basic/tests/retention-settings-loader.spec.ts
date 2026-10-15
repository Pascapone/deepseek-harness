/** Retention validation through real Loader, Settings and profile-patch writes. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import { expect, it, onTestFinished } from 'vitest'
import CompactionRetentionSettings from '../src/retention-settings.ts'

it('rejects every invalid Settings/ConfigEditor write before persistence, leaves siblings alone and removes unloaded guards', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'retention-settings-loader-')))
  onTestFinished(async () => {
    await rm(home, { recursive: true, force: true })
  })
  const dir = join(home, 'profiles', 'retention-test')
  initProfile(dir, ['retention-test-bundle'])
  const bundle = join(dir, 'node_modules', 'retention-test-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"retention-test-installation"}\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({
    name: 'retention-test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'compaction-retention', name: 'cordis:retention', config: { retention: { mode: 'tokens', value: 20_000 } } },
    { id: 'sibling', name: 'cordis:sibling' },
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'retention-test', startedBundles: ['retention-test-bundle'], dir,
    patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'),
    cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  let siblingValue!: Volatile<number>
  const loaded = await boot('retention-test', join(dir, 'cordis.yml'), readProfilePatches('retention-test', profile), (root) => {
    root.provide('profileContext', profile)
    root.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    Object.assign(root.loader.builtins, {
      editor: ConfigEditor, settings: Settings, retention: CompactionRetentionSettings,
      sibling: {
        Config: z.object({ value: z.number().default(1).volatile() }),
        apply: (_ctx: Context, config: { value: Volatile<number> }) => { siblingValue = config.value },
      },
    })
  })
  onTestFinished(async () => { await loaded.fiber.dispose() })
  const helper = loaded.compactionRetention
  const entry = loaded.configEditor.entries().find(row => row.options.id === 'compaction-retention')!
  const helperFiber = entry.fiber!
  let validations = 0
  const validatorFiber = loaded.plugin((owner: Context) => {
    owner.effect(() => helper.registerValidator((preference) => {
      validations += 1
      if (preference.mode === 'tokens' && preference.value >= 30_000) throw new Error('retention exceeds known model budget')
    }))
  })
  await validatorFiber.await()
  const before = await readFile(profile.patchPath, 'utf8')
  const invalid = { mode: 'tokens', value: 30_000 }
  for (const write of [
    () => loaded.settings.update('compaction-retention', { retention: invalid }),
    () => loaded.settings.replace('compaction-retention', { retention: invalid }),
    () => loaded.settings.mutate('compaction-retention', [{ op: 'set', path: ['retention'], value: invalid }]),
    () => loaded.configEditor.edit(entry, raw => ({ ...raw, retention: invalid })),
  ]) {
    await expect(write()).rejects.toThrow('retention exceeds known model budget')
    expect(await readFile(profile.patchPath, 'utf8')).toBe(before)
    expect(helper.current()).toEqual({ retainTokens: 20_000 })
    expect(entry.fiber).toBe(helperFiber)
  }
  const beforeSibling = validations
  await loaded.settings.update('sibling', { value: 40_000 })
  expect(siblingValue?.get()).toBe(40_000)
  expect(validations).toBe(beforeSibling)
  await loaded.settings.mutate('compaction-retention', [{ op: 'set', path: ['retention'], value: { mode: 'ratio', value: 0.05 } }])
  expect(helper.current()).toEqual({ retainRatio: 0.05 })
  expect(await readFile(profile.patchPath, 'utf8')).toContain('ratio')
  await validatorFiber.dispose()
  await loaded.settings.update('compaction-retention', { retention: invalid })
  expect(helper.current()).toEqual({ retainTokens: 30_000 })
  await helperFiber.dispose()
  expect(loaded.get('compactionRetention')).toBeUndefined()
  expect(loaded.settings.describe().some(row => row.ns === 'compaction-retention')).toBe(false)
})
