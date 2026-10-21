# ADR-009 — Single, Typed, Resumable WebSocket Protocol

**Status**: Proposed · 2026-09-01

## Context

Client devices must receive real-time streams: tokens, tool start events, execution progress, tool
outputs, confirmation requests, final answers, and errors. This must function over unstable mobile
connections, minimize battery drain, and multiplex across multiple concurrent devices (phone + PC
open on the same conversation).

## Decision

1. **One connection** per client session, multiplexed across channels (`conversation:*`, `run:*`,
   `user:*`).
2. **Native `ws`**, avoiding heavy proprietary frameworks like Socket.IO.
3. **Typed and versioned envelopes** (`v`, `id`, `type`, `ts`, `seq`, `channel`, `payload`),
   defined as a Zod discriminated union in `@nexus/contracts`, validated at both endpoints. Unknown
   event types are ignored, never fatal — older clients gracefully ignore newer events.
4. **Resumption by `seq`**: Run events are retained for 15 minutes in a Redis Stream;
   `subscribe { since }` replays missed frames upon reconnect. Temporary network drops never lose
   in-flight responses.
5. **Token coalescence** (~50 ms / 40 characters) and **bounded buffering**: under backpressure,
   token streaming drops rate while lifecycle state events are never sacrificed.
6. **Two distinct endpoints**: `/ws/client` and `/ws/device`.

## Alternatives

- **SSE + POST.** Simpler, traverses HTTP proxies easily, native reconnect with `Last-Event-ID`.
  Rejected: strictly unidirectional, requiring a secondary channel for streaming audio and
  confirmations; two communication mechanisms introduce more failure modes than one solid design.
- **Socket.IO.** Built-in reconnect and rooms, but uses a proprietary protocol, payload overhead,
  and complicates non-JS clients (potential Rust device agent, Python integration tests).
- **gRPC / Connect streaming.** Strong typing, but browser and React Native integration remains
  cumbersome, adding unnecessary tooling weight here.
- **One socket per run.** Connection handshake overhead and mobile battery drain would be
  prohibitive.

## Consequences

**Positive** — A single bidirectional channel to secure, monitor, and debug; shared contract typing;
clean resumption; broadcast "echo" sync across a user's devices comes naturally via channel
subscriptions.

**Negative, accepted** — Requires in-house implementation of reconnect logic, heartbeats,
backpressure, and replay buffers (~300 lines of fully tested code); corporate firewalls sometimes
interfere with WebSockets (future mitigation: read-only SSE fallback); replay buffer requires
time-bounded stream storage.
