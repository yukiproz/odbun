// R4 — undici is DELETED in this variant, not ported. Bun's native
// fetch replaces it (including the connection-test path that the
// parent's undici-socks5 patch existed to fix). Proxy behaviour comes
// from Bun fetch's own options/env handling; if a future need for a
// SOCKS proxy appears, it is implemented here against Bun's fetch
// `proxy` option — never by resurrecting undici.

export async function nativeFetch(
  input: string | URL,
  init: RequestInit & { proxy?: string } = {},
): Promise<Response> {
  return fetch(input, init as RequestInit);
}
