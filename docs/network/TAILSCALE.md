# Private access with Tailscale

Tailscale can expose a local NEXUS installation to trusted devices without publishing the Core API
to the public Internet. It is only a transport layer: NEXUS device identities, pairing, trust state,
capabilities, permissions and confirmations still apply. Membership in a tailnet never makes a
device trusted by NEXUS.

## Recommended topology

```text
NEXUS clients and workers -- HTTPS/WSS --> Tailscale Serve
                                                |
                                         127.0.0.1:3000
                                             NEXUS Core
```

Keep the API, PostgreSQL and Redis bound to loopback. Use **Tailscale Serve**, not Funnel: Serve is
limited to the tailnet, terminates TLS and proxies both HTTP and WebSocket traffic.

## Configure the Core host

1. Install Tailscale and join the host to your tailnet.
2. Enable MagicDNS and HTTPS certificates in the Tailscale admin console.
3. Confirm that NEXUS listens on loopback and that its data services are not reachable from the
   tailnet.
4. Start the private HTTPS proxy:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:3000
tailscale serve status
```

The status must say `tailnet only`. Never enable `tailscale funnel` for a personal NEXUS instance.

Set the public address that paired devices must use:

```dotenv
PUBLIC_API_URL=https://nexus-core.example-tailnet.ts.net
CORS_ORIGINS=https://nexus-core.example-tailnet.ts.net
```

`PUBLIC_API_URL` must be the address reachable by the device, not `localhost`. A React Native client
derives its WebSocket `Origin` from the socket URL, so the same HTTPS origin must be present in
`CORS_ORIGINS`.

## Restrict the tailnet

The default tailnet policy may allow every node to reach every other node. Limit clients and
workers to TCP 443 on the Core. Tags make this policy independent of hostnames and IP addresses:

```hujson
{
  "tagOwners": {
    "tag:nexus-core": ["autogroup:admin"],
    "tag:nexus-client": ["autogroup:admin"],
    "tag:nexus-worker": ["autogroup:admin"],
  },
  "grants": [
    {
      "src": ["tag:nexus-client", "tag:nexus-worker"],
      "dst": ["tag:nexus-core"],
      "ip": ["tcp:443"],
    },
  ],
}
```

A tagged device is owned by the tag instead of a user. Review Tailscale's tag semantics before
tagging a personal phone. User-based grants are a valid alternative for a small tailnet.

## Verify the complete path

Do not stop after an HTTP health check. Verify all of the following from a second physical device:

1. `GET https://<core-fqdn>/health` returns 200 with a valid certificate.
2. A newly paired NEXUS device remains `PENDING` until an administrator approves it.
3. `/ws/client` rejects a pending or revoked device and accepts an approved device.
4. The Core's direct API port, PostgreSQL and Redis are unreachable through the tailnet.
5. The effective Tailscale policy exposes only the intended Core endpoint.

Useful diagnostics:

```bash
tailscale status
tailscale ip
tailscale serve status
tailscale debug netmap
```

Never disable the host firewall to diagnose connectivity. Revoke a lost device in NEXUS first,
then remove it from the tailnet.

References: [Grants](https://tailscale.com/docs/reference/syntax/grants),
[HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates), and
[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).
