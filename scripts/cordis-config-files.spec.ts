import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cordisConfigFiles, readCordisConfigSource } from './cordis-config-files.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('cordisConfigFiles', () => {
  function trackedLink(target: string): string {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cordis-tracked-link-'))
    roots.push(root)
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: target, encoding: 'utf8' }).trim()
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `120000,${blob},cordis.yml`], { cwd: root })
    writeFileSync(join(root, 'cordis.yml'), target)
    return root
  }

  it('checks the YAML target of a flattened tracked link', () => {
    const root = trackedLink('target.yml')
    writeFileSync(join(root, 'target.yml'), '- id: checked\n  name: package\n')
    expect(readCordisConfigSource(root, 'cordis.yml')).toBe('- id: checked\n  name: package\n')
    writeFileSync(join(root, 'cordis.yml'), 'modified.yml')
    expect(() => readCordisConfigSource(root, 'cordis.yml')).toThrow('Modified flattened config link')
  })

  it('refuses escaping and cyclic tracked links', () => {
    expect(() => readCordisConfigSource(trackedLink('../outside.yml'), 'cordis.yml')).toThrow('leaves repository')
    expect(() => readCordisConfigSource(trackedLink('cordis.yml'), 'cordis.yml')).toThrow('Cyclic')
  })

  it('finds Loader YAML without treating translation records as configs', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cordis-config-files-'))
    roots.push(root)
    for (const directory of ['.claude', 'apps/cli/config/examples', 'docs', 'node_modules/pkg', 'vendor/pkg']) {
      mkdirSync(join(root, directory), { recursive: true })
    }
    for (const file of [
      '.claude/hidden.cordis.yml',
      'docs/cordis-primer.i18n.yaml',
      'apps/cli/config/examples/agent.cordis.yaml',
      'apps/cli/config/examples/headless.cordis.yml',
      'node_modules/pkg/hidden.cordis.yml',
      'vendor/pkg/hidden.cordis.yml',
    ]) {
      writeFileSync(join(root, file), '[]\n')
    }

    expect(cordisConfigFiles(root)).toEqual([
      join('apps', 'cli', 'config', 'examples', 'agent.cordis.yaml'),
      join('apps', 'cli', 'config', 'examples', 'headless.cordis.yml'),
    ])
  })
})
