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

Every request carries `requestId`, `issuedAt` and `nonce`. They are not
interchangeable: `requestId` makes a request traceable, `issuedAt` bounds how
long a captured request stays usable, and `nonce` stops a replay inside that
window, which a timestamp alone cannot do.

The signature covers the canonical encoding of the whole request — version,
method, parameters, request id, timestamp, nonce and client id — so a signature
observed on a harmless `connection.list` cannot be reused to make the connector
run probes.

Every refusal returns the same sentence. Telling a caller whether the key was
unknown, the signature wrong, the nonce reused or the timestamp stale hands them
a way to narrow down what to change.

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

- Presence detection for `codex`, `claude` and `agy`, via `--version`.
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
- **Not wired into the API or the dashboard.** Those are deliberately untouched
  in this batch.
