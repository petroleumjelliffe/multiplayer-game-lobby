import type { RosterMessage } from '../protocol/protocol';
import type { ConnectionStatus } from './connection';

/**
 * The minimum this view reads — deliberately structural rather than
 * `LobbyRoomState`, so a game's own wrapper satisfies it too. Acquire's
 * `useRoom` reshapes the hook's state (it adds a `playing` phase and drops
 * the `gone`/`stale` booleans into the phase), and requiring the hook's exact
 * return type would have shut it out of the thing built for it.
 */
export interface LobbySnapshot {
  /**
   * Any phase name. This view recognises `gone`, `stale` and `error`; a game
   * may have more — Acquire adds `playing` — and anything unrecognised is
   * simply not terminal.
   */
  phase: string;
  status: ConnectionStatus;
  roster: RosterMessage | null;
  playerId: string | null;
}

export interface LobbySeat {
  /** Server-assigned id, or null when nobody is sitting here. */
  id: string | null;
  /** 0-based position. Always present — games decorate by it. */
  index: number;
  name: string | null;
  isHost: boolean;
  isYou: boolean;
  connected: boolean;
  /** Your own seat, and only while the room is still a lobby. */
  canRename: boolean;
}

export interface LobbySpectator {
  id: string;
  name: string;
  connected: boolean;
  isYou: boolean;
}

export interface LobbyView {
  /** Exactly `limits.capacity` entries: the occupied ones, then empties. */
  seats: LobbySeat[];
  /** Whoever is watching. Unlike seats there is no capacity to pad to. */
  spectators: LobbySpectator[];
  /** Your seat — null while spectating, which is what `youAreSpectating` says. */
  you: LobbySeat | null;
  youAreSpectating: boolean;
  /**
   * Your seat, non-host, still in the lobby. Deliberately lobby-only even
   * though the wire allows mid-game conversion where the game opted in: that
   * allowance is the game's own policy (`allowMidgameSpectate`), so a game
   * that grants it draws its own mid-game control rather than reading this.
   */
  canSpectate: boolean;
  /** Spectating, still in the lobby, and a seat is free. */
  canTakeSeat: boolean;
  /** The room code. The *game* builds any URL from it — base paths are per-repo. */
  code: string;
  canBegin: boolean;
  beginBlocked: 'notHost' | 'notEnoughPlayers' | 'alreadyBegun' | null;
  connection: 'connecting' | 'live' | 'dropped';
  terminal: 'gone' | 'refused' | 'stale' | null;
}

/**
 * What the *game* knows about itself. Not sent by the server: both halves read
 * the same rule — `MAX_PLAYERS` builds the server's seat space and the
 * client's limits — so they cannot drift, and no protocol bump is spent on a
 * number neither side had to be told.
 */
export interface LobbyLimits {
  capacity: number;
  minPlayers: number;
}

const emptySeat = (index: number): LobbySeat => ({
  id: null,
  index,
  name: null,
  isHost: false,
  isYou: false,
  connected: false,
  canRename: false,
});

/**
 * The element inventory a lobby has: seats (occupied *and* empty), who you
 * are, the room code, whether you may begin, and how the connection stands.
 *
 * It exists because every consumer was re-deriving the same four facts —
 * `players.find(p => p.id === playerId)`, `me?.isHost`, `players.length >= 2`,
 * "may I rename this" — and could not derive the fifth at all: the roster
 * carries only occupied seats, so an empty one was inexpressible.
 *
 * Pure, and deliberately so. This is the half both games share, and neither
 * game's screens can be tested through the other's.
 */
export function lobbyView(state: LobbySnapshot, limits: LobbyLimits): LobbyView {
  const players = state.roster?.players ?? [];
  const lifecycle = state.roster?.lifecycle ?? 'lobby';

  const seats: LobbySeat[] = Array.from({ length: limits.capacity }, (_, index) => {
    const player = players[index];
    if (!player) return emptySeat(index);
    const isYou = player.id === state.playerId;
    return {
      id: player.id,
      index,
      name: player.name,
      isHost: player.isHost,
      isYou,
      connected: player.connected,
      canRename: isYou && lifecycle === 'lobby',
    };
  });

  const you = seats.find((seat) => seat.isYou) ?? null;

  // `?? []` twice over: no roster yet, or a roster from a server built before
  // spectating existed — a consumer mid-migration should degrade to "nobody
  // is watching", not throw.
  const spectators: LobbySpectator[] = (state.roster?.spectators ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    connected: s.connected,
    isYou: s.id === state.playerId,
  }));
  const youAreSpectating = spectators.some((s) => s.isYou);

  // notHost before notEnoughPlayers: a guest should be told the thing that is
  // theirs to know, not the thing that is merely also true.
  const beginBlocked: LobbyView['beginBlocked'] =
    lifecycle !== 'lobby'
      ? 'alreadyBegun'
      : you?.isHost !== true
        ? 'notHost'
        : players.length < limits.minPlayers
          ? 'notEnoughPlayers'
          : null;

  return {
    seats,
    spectators,
    you,
    youAreSpectating,
    canSpectate: lifecycle === 'lobby' && you !== null && !you.isHost,
    canTakeSeat:
      lifecycle === 'lobby' && youAreSpectating && players.length < limits.capacity,
    code: state.roster?.roomId ?? '',
    canBegin: beginBlocked === null,
    beginBlocked,
    connection:
      state.status === 'open' ? 'live' : state.status === 'closed' ? 'dropped' : 'connecting',
    // Read off the phase rather than re-ranked here. Both `useLobbyRoom` and
    // `useRoom` already decide that stale outranks gone — a client on the
    // wrong protocol cannot trust either answer it was given — and a third
    // copy of that ordering is a third place for it to drift.
    terminal:
      state.phase === 'stale'
        ? 'stale'
        : state.phase === 'gone'
          ? 'gone'
          : state.phase === 'error'
            ? 'refused'
            : null,
  };
}
