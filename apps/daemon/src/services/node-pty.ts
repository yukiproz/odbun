// odbun R2 — this module is the daemon's PTY seam. It KEEPS its
// historical name and exported surface (`loadNodePty`,
// `NodePtyUnavailableError`, the spawn-helper pair) because
// `terminals.ts` and the terminal routes are wired to them, but the
// implementation no longer loads the node-pty native addon: PTYs are
// provided by Bun.Terminal via `../bun/pty.ts`. There is no fallback
// to node-pty and no fallback to Node — when the Bun PTY surface is
// unavailable, `loadNodePty` rejects with the same
// NodePtyUnavailableError the daemon has always surfaced.

import { bunPtySupported, spawnBunPty } from '../bun/pty.js';
import type { BunPtyProcess, BunPtySpawnOptions } from '../bun/pty.js';

const NODE_PTY_UNAVAILABLE_CODE = 'NODE_PTY_UNAVAILABLE';

export class NodePtyUnavailableError extends Error {
  readonly code = NODE_PTY_UNAVAILABLE_CODE;

  constructor(cause: unknown) {
    super('The native PTY helper could not be loaded.', { cause });
    this.name = 'NodePtyUnavailableError';
  }
}

export function isNodePtyUnavailableError(error: unknown): error is NodePtyUnavailableError {
  return error instanceof NodePtyUnavailableError
    || (
      error instanceof Error
      && 'code' in error
      && error.code === NODE_PTY_UNAVAILABLE_CODE
    );
}

/**
 * node-pty shipped a native `spawn-helper` binary whose unpacked
 * execute bit sometimes needed repair. Bun.Terminal has no external
 * helper binary at all, so there is nothing to locate: the candidate
 * list is empty on every platform. Kept for surface compatibility
 * with `terminals.ts`'s re-export and its regression test (which
 * skips itself when no candidate exists).
 */
export function spawnHelperCandidatePaths(): string[] {
  return [];
}

/**
 * No-op under Bun: there is no spawn-helper whose execute bit could
 * need repair. Kept for surface compatibility; see
 * `spawnHelperCandidatePaths`.
 */
export function ensureSpawnHelperExecutable(): void {
  // Nothing to repair — Bun.Terminal needs no helper binary.
}

/** The module shape `loadNodePty` resolves to: node-pty's `spawn`,
 *  backed by the Bun.Terminal adapter. */
export interface PtyModule {
  spawn(file: string, args: string[] | string, options?: BunPtySpawnOptions): BunPtyProcess;
}

const bunPtyModule: PtyModule = {
  spawn(file, args, options = {}) {
    const argv = typeof args === 'string' ? (args ? [args] : []) : args;
    return spawnBunPty(file, argv, options);
  },
};

export async function loadNodePty(): Promise<PtyModule> {
  if (!bunPtySupported()) {
    throw new NodePtyUnavailableError(
      new Error('Bun.Terminal is unavailable in this Bun build'),
    );
  }
  return bunPtyModule;
}
