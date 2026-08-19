# multiplayer-game-lobby

Rooms, seats, join/rejoin tokens, presence, rename and leave — game-agnostic,
shared by [Acquire](https://github.com/petroleumjelliffe/acquire-startups-m1)
and [Rail Baron](https://github.com/petroleumjelliffe/railbaron).

```
protocol/   wire types, node-safe
server/     seating registry and socket handlers
client/     headless React: identity, connection, useLobbyRoom, view
```

Extracted from `acquire-startups-m1` at `64a533b` on 2026-08-13, with history —
`git log` here reaches back to the commit that first split the wire in two.

## Two rules for a consumer

**Shared as source, not as a package.** Acquire and Rail Baron are on different
React versions, and a built artifact would bake one React's JSX runtime and hook
types into both. Each consumer compiles these files with its own toolchain, as a
git submodule at `vendor/lobby`.

**Include only what you use.** A game with no server must keep `server/` out of
its `tsconfig` include — it imports `socket.io`, and the fix for the resulting
error is not to install `socket.io` but to stop compiling code you do not run.

## What this is not

**There is no UI here, and that is a correction rather than an omission.** An
earlier version shipped a "themeable default UI" behind three `--lobby-*` CSS
variables. Rail Baron — the first real second consumer — has neither Tailwind
nor `className`, and its lobby *is* a seven-row split-flap departures board,
which no amount of theming turns a card into.

What is shared is the **element inventory**, not components: representatives of
players, a way to add players, a share link, a begin control, presence, and
terminal states. `client/view.ts` hands those over as data; every game draws
them itself.

**No badge, either.** Decoration is derived by the game from the seat — Acquire
reads an emoji by seat index, Rail Baron's seat ids *are* its colours. Letting a
player *pick* one would be a choice rather than a derivation, and would need an
opaque field here plus uniqueness enforcement.

## The contract a game implements

See [`protocol/README.md`](protocol/README.md) — the room shape, the three
hooks (`onBegin`, `onSeated`, `onSpectate`), the optional mid-game spectate
policy, the protocol version, the `appId` namespace, and the seat-id space the
game supplies.

## The client integration checklist

The client half is headless hooks and callbacks, and its correct *usage
pattern* is as much a part of the contract as the types are. The second
consumer rebuilt that pattern from the API surface alone and hit every one of
these by hand; the third shouldn't have to. The reference integration is
Acquire's `src/net/connection.ts` — read it whole before writing yours.

- **One connection, module-owned, lazy.** A shared `getConnection()` singleton
  plus an explicit `closeConnection()`, opened on first use. Shared because
  the create screen and the room screen are two views of one connection — the
  server's rejoin shortcut keys on the *socket's own binding*, which is the
  creator's only claim to their seat until `useLobbyRoom` stores the identity
  from the `joined` reply. A second socket arrives as a stranger and takes a
  second seat.
- **Never close it in a component lifecycle.** React's StrictMode mounts,
  unmounts and remounts every component in development; a connection closed in
  an effect cleanup dies on that pass and nothing rebuilds it — `close()` is
  `socket.disconnect()`, which is permanent. The symptom is a room stuck on
  its connecting state with an empty roster and no error anywhere. Close only
  on an explicit leave.
- **Subscribe to `rejected` everywhere you act.** Failure on this wire is
  opt-in: every refusal arrives on that channel or not at all, and a channel
  left unread is a refusal shown to no one. That includes the messages
  `useLobbyRoom` exposes but deliberately ranks below the roster ("only the
  host may begin") — they reach nobody unless a screen carries them.
- **Behind a path proxy?** Pass `socketPath: '<base>/socket.io'` to
  `createLobbyConnection` and mount the server's SocketServer at the same
  path. Absent, both sides use socket.io's own `/socket.io` — right for a
  server that owns its whole origin, wrong behind a front door that only
  forwards your base path.
- **Test the composition layer.** The no-mock rule here covers
  `connection.ts` — a stubbed-socket test of it restates the file. It does
  not cover *your* glue: lifecycle (how many sockets get made, who closes
  them) and wiring (which channels are subscribed) test fine against a fake
  handed through an injectable `connect`, exactly as Acquire's page tests do.
  Every by-hand bug the second consumer found lived in glue its tests had
  excused.

## Tests

There is no build tooling here on purpose: this repo is compiled by its
consumers, and its tests run in theirs. Point your vitest globs at
`vendor/lobby/protocol/**`, `vendor/lobby/server/**` (node) and
`vendor/lobby/client/**` (jsdom). A consumer that does not run these will not
notice when a submodule bump breaks it.
