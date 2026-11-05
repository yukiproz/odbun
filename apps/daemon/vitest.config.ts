import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Node-harness exclusions for the Bun-only DB suites (port record:
// port/TEST-SUITES.md §4.1 / §7).
//
// The port made the daemon DB layer Bun-only: `src/bun/db.ts` imports
// `bun:sqlite`, which exists only inside the Bun runtime. Every suite
// whose import graph reaches the adapter therefore dies at collection
// under the Node harness ("Cannot find package 'bun:sqlite'") — 435
// suites in the reference run. Those suites are not broken; they
// exercise the Bun-only DB adapter in-process and they run on the Bun
// track (`bunx --bun vitest`). Under a runtime WITHOUT the Bun global
// (the Node harness) they are excluded via the committed manifest
// `tests/node-harness-exclusions.json` so the gate reports the
// runnable scope instead of 435 collection deaths; under Bun nothing
// is excluded. The manifest is generated from a CI Node-gate job log
// (see §7 for the regeneration recipe); do not edit it by hand.
// Exit condition: when the Bun track becomes the gate, this whole
// mechanism retires with the Node track.
const runningUnderBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

const nodeHarnessExclusions: string[] = runningUnderBun
  ? []
  : (
      JSON.parse(
        readFileSync(
          new URL('./tests/node-harness-exclusions.json', import.meta.url),
          'utf8',
        ),
      ) as string[]
    ).map((entry) => `**/${entry}`);

// Vitest replaces its default `exclude` when one is configured, so the
// upstream defaults are spelled out and the manifest extends them.
const defaultExclude = [
  '**/node_modules/**',
  '**/dist/**',
  '**/cypress/**',
  '**/.{idea,git,cache,output,temp}/**',
  '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
];

export default defineConfig({
  // Inline the contracts/Zod layer into Vite's module processing
  // (port/TEST-SUITES.md §4.3 / §7). Under the Bun runtime, Vitest's
  // externalized-CJS interop loads `zod` with its `z` namespace
  // undefined, and every suite whose graph reaches
  // `@open-design/contracts` dies at collection
  // ("undefined is not an object (evaluating 'z.enum')"). Forcing both
  // packages through the transform pipeline (the Vitest 4 successor of
  // `server.deps.inline`) makes Vite synthesize the named exports
  // itself; the daemon subset that was 0/7 under Bun went 6/7 files
  // fully green, the 7th (connection-test) loading and executing with
  // only environment-class failures. Semantically a no-op under the
  // Node harness, whose interop already resolves these packages.
  ssr: {
    noExternal: [/@open-design\/contracts/, /zod/],
  },
  test: {
    environment: 'node',
    // These suites mutate process-wide env/PATH and bind real local servers.
    // Keep files serial so fake agent binaries stay scoped to their tests.
    fileParallelism: false,
    include: ['tests/**/*.test.{ts,tsx,js,mjs,cjs}'],
    exclude: [...defaultExclude, ...nodeHarnessExclusions],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 20_000,
  },
});
