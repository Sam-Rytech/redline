# @redline/wizard-login

Sign-in with a WizardConnect wallet (Paytaca, Selene, …) for Bitcoin Cash web apps. No password, no email: the wallet signs, but does not broadcast, a tiny self-payment that commits to a server nonce. Harmless if a wallet broadcasts it anyway: the user pays about 400 sats of fee and the coin comes back to the same address.

Entry points:

| Import | Where | What |
|---|---|---|
| `@redline/wizard-login` | both | login tx format: `buildUnsignedLoginTx`, `encodeLoginOpReturn`, `decodeLoginOpReturn`, constants |
| `@redline/wizard-login/client` | browser | `connectWallet`, `wizardLogin`, `LoginError`, `deriveAddresses`, `pickLoginUtxo`, `txidOf` |
| `@redline/wizard-login/server` | server | `createChallenge`, `verifyLogin` (framework-agnostic, all I/O injected) |
| `@redline/wizard-login/testing` | tests | fixed-seed HD wallet + login tx signer |

Pins: `@wizardconnect/dapp` **0.2.8** and `@wizardconnect/core` **0.2.11** exactly (`dapp` depends on `core@*`), `@bitauth/libauth` 3.0.0.

## Protocol (v1)

1. The client pairs with the wallet over WizardConnect and receives the `receive` and `change` xpubs (chain nodes `m/44'/145'/0'/0` and `/1`).
2. It derives **receive** addresses 0–19 (P2PKH, `bitcoincash:`), asks the server for their UTXOs and picks the **smallest token-free UTXO ≥ 2,000 sats**. Only receive-path coins can sign in: the account id is `sha256(xpubReceive)`, so the login must prove that xpub.
3. `POST /auth/challenge { outpoint, path: ["receive", index] }` → `{ nonce, expiry, domain }`. The server stores `{ nonce (16 random bytes), expiry = now + 300 s, domain, outpoint, path, sha256(browser id) }` and sets the random browser id as an HttpOnly cookie (`rl_ch`, Path=/api/auth). This ties the challenge to the browser that asked for it, so a leaked login tx cannot be redeemed elsewhere. The challenge holds no keys.
4. The client builds the login transaction:
   - version 2, locktime 0, one input = the chosen UTXO, sequence `0xffffffff`;
   - output 0: value 0, `OP_RETURN` + minimal pushes `"WZL1"` | domain (utf-8) | nonce (16 B) | expiry (uint32 LE);
   - output 1: P2PKH back to the **same address**, value = input − 400 sats (server accepts a 200–2,000 fee);
   - no tokens anywhere.
5. The wallet signs with `broadcast: false`, `inputPaths: [[0, "receive", index]]`. The signature must be **SIGHASH_ALL|FORKID (0x41)** so it covers the nonce output.
6. `POST /auth/verify { signedTxHex, xpubReceive, xpubChange }` (with the `rl_ch` cookie). The server checks, in order: both xpubs mainnet and different; tx template; domain, known nonce, browser binding, not expired, unused; fetches the source output **from the chain itself** (token-free, ≥ 2,000 sats); its address equals the receive xpub's child at the stated index and output 1 pays back to it; unlocking bytecode is exactly `<sig 0x41> <derived pubkey>` and the libauth VM verifies the whole tx; the outpoint is unspent or spent by exactly this tx.
7. The server marks the nonce used and issues a session (HttpOnly cookie). Redline keeps the xpubs only inside the encrypted session row.

Properties: replay-proof (single-use nonce, 5-minute expiry), bound to the site's domain and to the requesting browser; the server never trusts client-supplied coin data. Privacy: signing in reveals one UTXO and the wallet's receive/change xpubs to the server.

## Client

```ts
import { connectWallet, wizardLogin, LoginError, txidOf } from "@redline/wizard-login/client";

const conn = connectWallet({ dappName: "My dapp" });
renderQr(conn.qrUri);                 // or <a href={conn.qrUri}> for a wallet on the same device
await conn.ready;                     // walletready (rejects on disconnect / close before that)

try {
  const me = await wizardLogin({
    manager: conn.manager,
    apiBase: "/api",                  // default
    onStep: (step, detail) => log(step, detail), // addresses → utxos → challenge → signing → verifying
    onSigned: (hex) => log("txid", txidOf(hex)),
  });
} catch (e) {
  if (e instanceof LoginError) showError(e.code, e.message);
  else throw e;                       // e.g. AbortError when `signal` was aborted
}
await conn.close();                   // sendDisconnect, destroy, relay cleanup
```

### `connectWallet(opts?) → WalletConnection`

- `opts.dappName` (default `"Redline"`), `opts.dappIcon`, `opts.relay` (`DappRelayOptions`), `opts.onRelayStatus(status, error)`.
- Returns `{ qrUri, ready, manager, walletName(), close() }`. `manager` is the `DappConnectionManager` (events `walletready`, `disconnect`, `reconnecting`). Session persistence is off in v1.
- `close()` cancels any pending sign request; its outcome is then unknown (the wallet may have signed) — never retry it automatically with another wallet.

### `wizardLogin(opts) → Promise<MeResponse>`

Options: `manager` (anything with `getSessionPaths` and `signTransaction`), `apiBase`, `signal`, `onStep`, `onSigned`, `fetch`. Every request uses `credentials: "include"`, POSTs send `Content-Type: application/json`; the API must be same-origin (or CORS with credentials) so the `rl_ch` and session cookies flow. Redline's server also wants an age check first (`POST /api/age-check`).

Expected server routes (relative to `apiBase`): `GET /utxos?addresses=a,b,…` → `Utxo[]` (with token data), `POST /auth/challenge`, `POST /auth/verify` → your session response. Errors as `{ error: { code, message } }`.

`LoginError.code`:

| code | meaning |
|---|---|
| `no_paths` | the wallet did not share usable `receive` + `change` xpubs |
| `no_funds` | no token-free coin ≥ 2,000 sats on receive addresses 0–19; the message asks the user to send 2,000 sats and names receive address 0 (`e.address`) |
| `wallet_rejected` | the wallet refused or failed to sign; its own message is kept |
| `server_rejected` | non-2xx from the server; message `"<code>: <message>"`, plus `e.serverCode`, `e.status` |
| `network` | server unreachable, or the response was not JSON |

Helpers: `deriveAddresses(xpub, count, start = 0)`, `pickLoginUtxo(utxos)`, `txidOf(txHex)`.

## Server

```ts
import { createChallenge, verifyLogin, ChallengeError } from "@redline/wizard-login/server";

// POST /auth/challenge
const { challenge, browserId } = createChallenge(body, { domain: LOGIN_DOMAIN, now: nowSec(), randomBytes });
await store.insert(challenge);                       // holds only sha256(browserId), no keys
setCookie("rl_ch", browserId, { httpOnly: true, sameSite: "Lax", path: "/api/auth", maxAge: 300, secure: true });
return { nonce: challenge.nonceHex, expiry: challenge.expiry, domain: challenge.domain };

// POST /auth/verify
const result = await verifyLogin(body /* { signedTxHex, xpubReceive, xpubChange } */, {
  domain: LOGIN_DOMAIN,
  browserId: getCookie("rl_ch") ?? null,             // clear the cookie whatever the outcome
  now: nowSec,
  getChallenge: (nonceHex) => store.get(nonceHex),
  markChallengeUsed: (nonceHex, now) => store.markUsed(nonceHex, now), // atomic; false if already used
  getSourceOutput: (outpoint) => electrum.getOutput(outpoint),         // from the chain, with token data
  isUnspentOrSpentBy: (outpoint, txid) => electrum.unspentOrSpentBy(outpoint, txid),
});
if (!result.ok) return error(result.code, result.message); // Redline: 403 / 410 for the challenge codes, else 422 login_invalid
startSession(result.accountId, result.xpubReceive, result.xpubChange); // accountId = sha256(xpubReceive)
```

`createChallenge` throws `ChallengeError` (`bad_request`, `bad_path`). `verifyLogin` failure codes: `bad_xpub`, `bad_tx`, `bad_domain`, `unknown_nonce`, `challenge_mismatch`, `outpoint_mismatch`, `challenge_expired`, `challenge_used`, `source_missing`, `token_source`, `source_too_small`, `wrong_address`, `bad_fee`, `bad_signature`, `spent`. Also rate-limit the challenge/verify/UTXO routes and require `Content-Type: application/json` on POSTs (CSRF). A full Hono implementation is in `apps/server/src/app.ts`.

## Tests

`pnpm --filter @redline/wizard-login test` — protocol, server verification, client helpers, and `wizardLogin` end-to-end against the real Redline server app (in-memory DB, fake chain, a fake `fetch` with a cookie jar).
