import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@excalidraw/excalidraw': resolve(__dirname, 'tests/helpers/excalidraw-mock.tsx'),
      'motion/react': resolve(__dirname, 'tests/helpers/motion-mock.tsx'),
    },
  },
  test: {
    environment: 'node',
    server: {
      deps: {
        // zod must be inlined (transformed by Vite), never externalized.
        // Vitest's external-module interop (VitestModuleEvaluator
        // .runExternalModule -> interopModule) treats any non-.mjs module
        // with a `default` export as CJS and, when
        // `"__esModule" in mod.default` holds, rebinds the module namespace
        // to its default export. zod's ESM entry (index.js, not .mjs) is
        // `export * from './v3/external.js'; export { z }; export default z`
        // — its default is the external namespace (107 names), which lacks
        // the explicit `z` export. Under Node the `__esModule` probe is
        // false for a module namespace, so the interop is a no-op; under
        // Bun `'__esModule' in <namespace>` is true, the namespace is
        // replaced by its default, `import { z } from 'zod'` yields
        // undefined, and every suite importing @open-design/contracts
        // fails at collection with
        // `TypeError: undefined is not an object (evaluating 'z.enum')`.
        // Inlining routes zod through Vite's ESM transform, which
        // preserves the `z` binding on both runtimes.
        inline: ['zod'],
      },
    },
    include: ['tests/**/*.test.{ts,tsx}'],
    // Keep this above the shared Testing Library asyncUtilTimeout so failed
    // waits retain Testing Library's assertion/DOM diagnostics.
    testTimeout: 5_000,
    setupFiles: ['./tests/setup/jsdom-lexical.ts', './tests/setup/coalesced-get-reset.ts'],
  },
});
