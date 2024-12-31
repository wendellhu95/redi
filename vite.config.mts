import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@wendellhu/redi': join(__dirname, 'src'),
      '@wendellhu/redi/react-bindings': join(__dirname, 'src/react-bindings'),
    },
  },
  test: {
    globals: true,
    coverage: {
      provider: 'custom',
      customProviderModule: '@vitest/coverage-istanbul',
    },
  },
})
