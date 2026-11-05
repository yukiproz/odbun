import { vi, type Mock } from 'vitest';

/**
 * Fetch doubles for daemon tests.
 *
 * Daemon code accepts injectable fetch implementations typed as
 * `typeof fetch`. With Bun's types loaded into the program (the daemon
 * tsconfig wires `@types/bun` in), `typeof fetch` also carries Bun's
 * `fetch.preconnect` extension member, which a bare async arrow function
 * does not have — so a plain arrow is no longer assignable where
 * `typeof fetch` is required. The helpers here attach the missing member
 * so a double satisfies the type with the members it actually has,
 * instead of asserting them through a cast.
 *
 * The attached `preconnect` is a no-op: preconnect is only a
 * connection-warming hint, and no code under test depends on its effect.
 *
 * The impl parameter is a loose rest-args callable (the same shape
 * vitest's own `Procedure` uses for doubles): a double may declare a
 * narrower parameter list than `fetch` itself, because it only ever
 * receives the arguments the code under test actually passes. Attaching
 * `preconnect` then makes the completed double assignable to
 * `typeof fetch` with exactly the members it has.
 */
export function completeFetch(
  impl: (...args: any[]) => Promise<Response>,
): typeof fetch {
  return Object.assign(impl, { preconnect: () => {} });
}

/** A `vi.fn` fetch double; the mock satisfies `typeof fetch` as-is. */
export function fetchMock(
  impl?: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>,
): Mock<typeof fetch> {
  return impl === undefined
    ? vi.fn<typeof fetch>()
    : vi.fn<typeof fetch>(completeFetch(impl));
}
