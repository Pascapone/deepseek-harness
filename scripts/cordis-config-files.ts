/** Cordis Loader configuration file discovery. */

import { execFileSync } from 'node:child_process'
import { globSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

/**
 * Return repository-relative Cordis Loader YAML paths under `root`.
 *
 * Translation consistency records are YAML sidecars, never Loader inputs.
 *
 * @param root Repository root to scan.
 * @returns Sorted repository-relative Loader configuration paths.
 */
export function cordisConfigFiles(root: string): string[] {
  return globSync(['**/*cordis*.yml', '**/*cordis*.yaml'], {
    cwd: root,
    exclude: ['.claude/**', 'node_modules/**', 'vendor/**', '**/*.i18n.yaml'],
  }).sort()
}

/**
 * Read Loader YAML through tracked links flattened by a symlinks-disabled checkout.
 * @param root - Repository root.
 * @param file - Repository-relative config path.
 * @returns Target contents; modified, escaping, and cyclic links are refused.
 */
export function readCordisConfigSource(root: string, file: string): string {
  const seen = new Set<string>()
  let path = resolve(root, file)
  while (true) {
    if (seen.has(path)) throw new Error(`Cyclic tracked config link: ${file}`)
    seen.add(path)
    const source = readFileSync(path, 'utf8')
    if (!lstatSync(path).isFile()) return source
    const repoPath = relative(root, path).replaceAll('\\', '/')
    const entry = execFileSync('git', ['ls-files', '--stage', '--', repoPath], { cwd: root, encoding: 'utf8' })
    const match = /^120000 ([a-f0-9]{40,64}) 0\t/u.exec(entry)
    if (match === null) return source
    const blob = execFileSync('git', ['cat-file', 'blob', match[1] ?? ''], { cwd: root, encoding: 'utf8' })
    if (source !== blob) throw new Error(`Modified flattened config link: ${file}`)
    const target = resolve(dirname(path), source)
    const rel = relative(root, target)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) {
      throw new Error(`Tracked config link leaves repository: ${file}`)
    }
    path = target
  }
}
