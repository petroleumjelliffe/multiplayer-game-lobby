// The lobby half of the wire: room management, seats, presence.
// Game-agnostic and self-contained — imports nothing from this repo.

export type Lifecycle = 'lobby' | 'playing' | 'over';

/**
 * The refusals the lobby itself issues and branches on. Everything else on the
 * `rejected` channel (engine refusals, `undoOutOfSegment`) passes through this
 * layer opaquely for the game to interpret — which is how `useRoom` always
 * behaved; this type names it.
 *
 * `notConnected` is not a refusal at all in the protocol sense — the server
 * never sends it — it is the client's own signal that the transport is down,
 * given a real member here rather than borrowing an unrelated wire code.
 *
 * `noSuchRoom` and `seatRefused` are one refusal split in two, because they
 * have different remedies. Nothing reaches a room that is not there, so that
 * is an ending: the game may have finished, or the server may have restarted
 * with an ephemeral disk. A room that is there but refuses this seat means the
 * stored identity is stale, and joining fresh works. Sending one code for both
 * made every wiped game read as `cannot join ABC123`.
 */
export type LobbyRejectionCode =
  | 'noSuchRoom'
  | 'seatRefused'
  /**
   * The client and the server do not speak the same protocol.
   *
   * Its own code, deliberately. A stale client told `noSuchRoom` goes hunting
   * for a room that is perfectly fine, and the player has no way to learn that
   * reloading is the fix.
   */
  | 'versionMismatch'
  | 'notConnected';

/**
 * Typed generically — `code: string`, not a union — because the lobby only
 * branches on `LobbyRejectionCode` and forwards the rest.
 */
export interface RejectedMessage { code: string; message: string }

export interface JoinedMessage {
  roomId: string;
  playerId: string;
  /** Presented on rejoin. Issued once, at first join, and never re-issued. */
  token: string;
}

export interface RosterMessage {
  roomId: string;
  lifecycle: Lifecycle;
  players: { id: string; name: string; isHost: boolean; connected: boolean }[];
  /**
   * Watchers, by name. Deliberately public: a table knows who is standing
   * behind it. A spectator holds no seat — their id is minted outside the
   * game's seat space and never appears in `players`, which is what keeps a
   * game's per-seat projection from ever having a hand to send them.
   */
  spectators: { id: string; name: string; connected: boolean }[];
}

/**
 * `name` is optional on both, and that is a correction to v2 rather than a v3:
 * v2 has never been deployed — prod still speaks v1 — so no client in the
 * world sends the required-name shape. Adding a name later would have cost a
 * cutover; adding it now costs nothing. Do not read the absent bump as a
 * missed one.
 *
 * An absent name means "you name me": the server seats you and names you by
 * your seat number, which is the only thing that knows it. See
 * `server/rooms.ts`'s `seatPlayer`.
 */
export interface CreateRoomMessage { name?: string; protocolVersion: number }
export interface JoinRoomMessage {
  roomId: string;
  name?: string;
  playerId?: string;
  token?: string;
  /**
   * Arrive as a watcher rather than a player, in any lifecycle — it is the
   * way into a room whose game has already begun, or whose seats are full.
   * An explicit request to watch never triggers the honor-system seat
   * reclaim: someone asking to spectate must not capture an abandoned seat
   * that happens to share their name.
   */
  spectate?: boolean;
  protocolVersion: number;
}
export interface RenamePlayerMessage { name: string }

export const LOBBY_CLIENT_EVENTS = {
  createRoom: 'createRoom',
  joinRoom: 'joinRoom',
  beginGame: 'beginGame',
  /**
   * Change your own seat's name, in the lobby only. Identity comes from the
   * socket binding, never the payload — there is no way to rename anyone
   * else. Lobby-only because the engine copies names into `GameState` at
   * startGame; a mid-game rename would leave the roster and the log
   * disagreeing about who did what.
   */
  renamePlayer: 'renamePlayer',
  /**
   * Vacate your own seat, in the lobby only — your own and nobody else's,
   * since identity comes from the socket binding. Sent by the lobby's `Leave`.
   * Distinct from a disconnect, which keeps the seat and marks it away: this
   * one gives it up.
   */
  leaveSeat: 'leaveSeat',
  /**
   * Give up your own seat and stay to watch. Non-host only — a host stepping
   * back is `leaveSeat`, which promotes a replacement; converting them would
   * leave a room nobody can start. Always allowed in the lobby; mid-game only
   * when the game opts in via `LobbyHooks.allowMidgameSpectate`.
   *
   * The seat id returns to the pool and the watcher gets a fresh identity
   * (spectator ids live outside the seat space), delivered by a new `joined`.
   */
  spectate: 'spectate',
  /**
   * The reverse: a spectator takes a free seat. Lobby-only — a started game's
   * seats were dealt into, and arriving in one mid-game is not built.
   */
  takeSeat: 'takeSeat',
} as const;

export const LOBBY_SERVER_EVENTS = {
  joined: 'joined',
  roster: 'roster',
  rejected: 'rejected',
} as const;
