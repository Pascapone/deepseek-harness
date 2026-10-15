import { defineConfig } from 'tsdown'

/** Keep both Loader entries self-contained for published installations. */
export default defineConfig(['index', 'retention-settings'].map(name => ({
  entry: [`lib/types/${name}.js`],
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'es2024' as const,
  fixedExtension: false,
  dts: false,
  clean: false,
})))
