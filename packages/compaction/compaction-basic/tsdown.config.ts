import { defineConfig } from 'tsdown'

/** Keep the engine Loader entry self-contained for published installations. */
export default defineConfig(['index'].map(name => ({
  entry: [`lib/types/${name}.js`],
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'es2024' as const,
  fixedExtension: false,
  dts: false,
  clean: false,
})))
