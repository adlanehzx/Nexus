# @nexus/connector

A local service that answers one question — _what agent tooling is installed on
this machine, and does it work?_ — so that a desktop shell, a CLI and a
dashboard do not each reimplement spawning other people's binaries.

It listens on loopback or a Unix socket, authenticates every request with
Ed25519, and runs only commands declared ahead of time in
[`@nexus/connections`](../../packages/connections).

## What it does not do

This is the short list, because it is the part that matters.

- **No arbitrary execution.** The method set is closed and no method takes an
  executable, an argument list or a shell string. Commands come from the
  provider registry, which is code, not from a request.
- **No credentials, in either direction.** Requests carry a signature, never a
  token. Responses carry connection states, never a token, cookie,
  authorization header or environment. Reusing a provider's existing session
  means letting that provider's own CLI find it — never copying what it holds.
- **No trust in the transport.** Loopback is containment, not authorisation:
  every process on the machine can reach it, including a page in the user's
  browser. The signature is the actual check.

## Protocol

One endpoint, `POST /rpc`, carrying a signed envelope.

| Method              | Runs a process | Answers                                       |
| ------------------- | -------------- | --------------------------------------------- |
| `health`            | no             | liveness and the protocol versions understood |
| `capabilities`      | no             | the method list                               |
| `connection.list`   | no             | connections as last observed                  |
| `connection.detect` | yes            | runs the declared presence probes             |
| `connection.test`   | yes            | re-runs the declared probes for one provider  |

The two methods marked "runs a process" are the ones subject to the concurrency
limit below.

Every request carries `requestId`, `issuedAt` and `nonce`. They are not
interchangeable: `requestId` makes a request traceable, `issuedAt` bounds how
long a captured request stays usable, and `nonce` stops a replay inside that
window, which a timestamp alone cannot do.

The signature covers the canonical encoding of the whole request — version,
method, parameters, request id, timestamp, nonce and client id — so a signature
observed on a harmless `connection.list` cannot be reused to make the connector
run probes.

Every authentication failure returns the same code and the same sentence —
`authentication_failed`, "This request was refused." — whatever the cause. There
is no `replayed_request` and no `expired_request`, because each distinction
narrows what an attacker has to change next: "replayed" confirms the signature
was good, "expired" confirms the key was accepted, and "unknown client"
confirms which identifiers exist. The payload is identical byte for byte, not
merely the code; a difference in wording or an extra field is an oracle too.

The precise reason is kept, in the local audit trail only, as
`authFailureReason`: one of `unknown_client`, `invalid_signature`,
`expired_timestamp`, `future_timestamp`, `malformed_timestamp` or
`replayed_nonce`. An operator still needs to tell a clock problem from an
attack; that information moved, it did not disappear.

## Bounded by construction

The transport refuses to be an unbounded resource for an unauthenticated
caller:

- **Size, twice.** A declared `Content-Length` over the limit is refused before
  a byte is read; the streaming limit then enforces the same ceiling on what
  actually arrives, because a header is a claim by the peer and chunked
  encoding lets them omit it entirely. An overflowing body has its socket
  destroyed rather than drained.
- **Time, with a resolution.** `headersTimeout` and `requestTimeout` are set,
  and so is `connectionsCheckingInterval` — without that last one Node checks
  connections every 30 seconds by default, so a five-second timeout actually
  lands somewhere under thirty-five. Verified: a 300 ms header timeout with the
  default interval did not fire within five seconds.
- **Headers.** `maxHeaderSize` is bounded, as is the keep-alive idle time.
- **Concurrent probes.** Two at a time by default. Each one spawns processes on
  a machine somebody is using, so this limits what a client can make the host
  do. Exceeding it returns `capacity_exhausted`, a distinct code because the
  right response differs: retry shortly, with nothing to fix. Read-only methods
  are not counted — they spawn nothing.
- **Failures.** Every rejection from the request handler is caught inside the
  `createServer` callback. Without that, one malformed request becomes an
  unhandled rejection, which by default ends the process. The reply is a fixed
  `internal_error` with no detail from the exception, since a message or a
  stack can carry a path or a provider's output.

The capacity gate runs **after** authentication, deliberately. The method is
only trustworthy once the signature verifies, so a limit applied to an
unauthenticated body could be bypassed by claiming a read-only method — and
would leak how busy the connector is to anyone who asked.

All limits are injectable, which is how they are tested: the suite uses 300 ms
timeouts and 256-byte bodies rather than waiting on realistic ones.

## Configuration

See [`config/connector.example.json`](config/connector.example.json). It holds
public keys only; there is no field for a token or a shared secret, and a
private key pasted into it is refused rather than tolerated. A test loads the
example on every run, so it cannot drift into a shape that does not work.

```jsonc
{
  "clients": [{ "clientId": "nexus-desktop", "publicKey": "-----BEGIN PUBLIC KEY-----…" }],
  "listen": { "kind": "loopback", "port": 8787 }, // or { "kind": "unix", "path": "…" }
  "acceptanceWindowMs": 30000,
  "clockSkewMs": 5000,
}
```

An empty `clients` list accepts nobody. That is the right default for something
whose job is running local binaries.

## What is actually working today

- Presence detection for `codex`, `claude` and `agy`, via `--version`, on Linux
  and macOS.
- The full protocol: version negotiation, authentication, replay protection,
  redacted audit, loopback and Unix socket transports.

## Known limitations

- **No provider reaches `connected`.** The strongest state a shipped provider
  reaches is `detected`, meaning installed and runnable. Claiming a working
  session requires a session probe whose real output has been observed in each
  of its failure modes, which has not been done. The mechanism exists and is
  tested with fake binaries; adding a probe is a change to one file.
- **The `agy` presence probe is marked `unverified`.** `--version` follows the
  convention the other two use, but it has not been observed on a real install.
- **Nonces are held in memory.** A restart forgets them, so a request captured
  seconds beforehand could be replayed once afterwards; the timestamp check
  bounds that to the acceptance window.
- **Windows is not supported.** npm installs its executables there as `.cmd`
  shims, a `.cmd` cannot be started without `cmd.exe`, and quoting arguments for
  `cmd.exe` is the problem CVE-2024-27980 exists about. Declaring support would
  mean either lying about what works or adding a `shell: true` path, and a
  version probe is not worth an injection surface. The refusal is enforced in
  code (`launchability` in `@nexus/connections`) and reports
  `unsupported_platform`, not `not_found`, so nobody is sent to reinstall a tool
  that is fine. Lifting it means resolving a shim to the Node script it wraps and
  verifying that on a real Windows machine; the Windows behaviour assumed here
  was read from Node's documented restriction, not observed.
- **No adapter availability is ever claimed.** The provider CLI and the ACP
  adapter are separate installs, no adapter probe is declared yet, so
  availability reports `unknown` rather than guessing from the CLI.
- **No adapter is classified as officially maintained.** An npm scope is a name
  and does not establish who publishes under it. Codex and Claude adapters are
  `unknown`, Antigravity is `community`, and each records the vendor evidence
  that would justify an upgrade.
- **Not wired into the API or the dashboard.** Those are deliberately untouched
  in this batch.
