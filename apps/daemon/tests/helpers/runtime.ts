// Runtime detection for harness-scoped test guards.
//
// The port made specific daemon code paths Bun-only in-process (the
// bun:sqlite DB adapter, and the Bun.spawn-based spawn helpers such as
// execFileBun). Tests that exercise those paths in-process cannot run
// under the Node harness — they fail with `Bun is not defined` — but
// they run on the Bun track (`bunx --bun vitest`). Guard such tests
// with `it.skipIf(!isBun)` / `describe.skipIf(!isBun)` /
// `test.skipIf(!isBun)` at the narrowest scope, so the Node harness
// reports them as skipped (not failed) while the Bun track executes
// them. See port/TEST-SUITES.md §4.2 / §7.

/** True when the test process itself runs on the Bun runtime. */
export const isBun: boolean = typeof Bun !== 'undefined';
