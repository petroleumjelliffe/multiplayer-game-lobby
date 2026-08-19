import { useCallback, useEffect, useRef, useState } from 'react';
import type { RosterMessage } from '../protocol/protocol';
import type { LobbyConnection, ConnectionStatus } from './connection';
import type { IdentityStore } from './identity';

export type LobbyPhase = 'connecting' | 'joining' | 'lobby' | 'error' | 'gone' | 'stale';

export interface LobbyRoomState {
  phase: LobbyPhase;
  status: ConnectionStatus;
  roster: RosterMessage | null;
  playerId: string | null;
  message: string | null;
  gone: boolean;
  stale: boolean;
  /**
   * Join again after a refusal. The name is optional — omitting it asks the
   * server to name the seat, which is what every ordinary arrival now does.
   */
  join(name?: string): void;
  /**
   * Join as a watcher instead — any lifecycle, so it is the offer a screen
   * makes when a join was refused because the game already began or the
   * seats are full. Never triggers the honor-system seat reclaim.
   */
  watch(name?: string): void;
  begin(): void;
  /** Rename your own seat, lobby-only. The roster broadcast is the answer. */
  rename(name: string): void;
  /**
   * Give up your own seat, lobby-only — the lobby's `Leave`. Clears the stored
   * identity too: the seat is gone, so the token is dead, and keeping it
   * would make the next visit attempt a rejoin the server must refuse.
   */
  leaveSeat(): void;
  /**
   * Give up your seat but stay to watch. Non-host only; lobby always, mid-game
   * only where the game opted in — the server refuses the rest, and the
   * refusal arrives on `message`. The new identity arrives as an ordinary
   * `joined`, so the stored one updates without any handling here.
   */
  spectate(): void;
  /** Take a free seat while spectating, lobby-only. The reverse of `spectate`. */
  takeSeat(): void;
}

/**
 * connect → join → lobby.
 *
 * Headless and game-agnostic: it knows nothing about a session, a board, or
 * what "playing" means. A caller that builds a game session out of the state
 * this reports (`src/net/useRoom.ts`, today's only one) owns that ranking
 * itself — `phase` here stops at `lobby`, never claims `playing`.
 */
export function useLobbyRoom(
  roomId: string,
  connection: LobbyConnection,
  identity: IdentityStore,
): LobbyRoomState {
  const [status, setStatus] = useState<ConnectionStatus>(() => connection.status());
  const [roster, setRoster] = useState<RosterMessage | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [stale, setStale] = useState(false);

  // Read once, at mount, for whatever `roomId` the hook first saw. A `roomId`
  // change on an already-mounted instance would keep the old room's identity
  // rather than loading the new room's — unreachable today because every
  // navigation into `/room/:roomId` comes from another route, never a
  // same-instance param change. A future room-switch flow (leave and rejoin
  // without a full navigation) would need to revisit this.
  const identityRef = useRef(identity.loadIdentity(roomId));
  // True once a `roster` has actually seated us — the moment a rejection can
  // no longer mean "our join was refused" and starts meaning "something we
  // tried inside the lobby was refused" instead.
  const seatedRef = useRef(false);
  // Last known connection status, so the status subscription below can tell
  // "just dropped" from "still down" and "just recovered" apart, rather than
  // firing on every intermediate `connecting` pulse a reconnect attempt sends.
  const wasOpenRef = useRef(false);
  // Declared here, ahead of the effects that read and reset it, purely for a
  // reader's sake — the status effect below closes over it regardless of
  // source order, since every hook in this component runs before any effect
  // body does.
  const sent = useRef(false);

  // Status, roster, identity, and the lobby's own rejections.
  useEffect(() => {
    setStatus(connection.status());
    wasOpenRef.current = connection.status() === 'open';

    const offStatus = connection.subscribe(() => {
      const next = connection.status();
      if (wasOpenRef.current && next !== 'open') {
        // A live connection just dropped. `sent` is what stops the join
        // effect below from ever re-sending `joinRoom` — reset it so the
        // reconnect this same subscription will observe (when `next` becomes
        // 'open' again) resends it with the stored token, which is the
        // machinery `server/rooms.ts`'s `join` already accepts for a rejoin.
        sent.current = false;
      }
      wasOpenRef.current = next === 'open';
      setStatus(next);
    });

    const offJoined = connection.onJoined((msg) => {
      const newIdentity = {
        playerId: msg.playerId,
        token: msg.token,
        name: identityRef.current?.name ?? identity.rememberedName() ?? '',
      };
      identityRef.current = newIdentity;
      identity.saveIdentity(msg.roomId, newIdentity);
      setPlayerId(msg.playerId);
      setMessage(null);
    });

    const offRoster = connection.onRoster((msg) => {
      seatedRef.current = true;
      setRoster(msg);
    });

    const offRejected = connection.onRejected((msg) => {
      // Nothing this player can do reaches this room: it has ended, or the
      // server restarted onto a disk that no longer holds it. A join form
      // would invite them to keep trying something that cannot work. This is
      // terminal.
      if (msg.code === 'noSuchRoom') {
        setGone(true);
        // Nothing can use a token for a room that is not there, and a
        // mid-game player is `seated`, so the clearing below would skip
        // them.
        identity.clearIdentity(roomId);
        identityRef.current = null;
        return;
      }

      // Terminal for the same reason `noSuchRoom` is: nothing this client
      // sends will be accepted until it is reloaded.
      //
      // Unlike `noSuchRoom`, the stored identity is **kept**. The room is
      // fine and the seat is still theirs — it is this client that cannot
      // talk. Clearing it would turn a reload, which fixes this, into a lost
      // seat, which nothing fixes.
      if (msg.code === 'versionMismatch') {
        setStale(true);
        return;
      }

      // A rejection that is neither terminal is shown as a note. A caller
      // that has built something out of this state (a game session, mid-turn)
      // ranks its own phase above `error` so a refusal never replaces it —
      // this hook has no such state to protect and always surfaces it.
      setMessage(msg.message);

      // A rejection that arrives before we have ever been seated can only be
      // the join itself being refused — and if it was attempted with a
      // stored identity, that identity is what got refused: a stale token,
      // or a seat the server has forgotten. Nothing downstream can turn it
      // into a working seat, so keeping it only guarantees every future visit
      // repeats the same doomed rejoin. Clearing it is what lets a later load
      // offer a clean join instead.
      if (!seatedRef.current && identityRef.current !== null) {
        identity.clearIdentity(roomId);
        identityRef.current = null;
      }
    });

    return () => { offStatus(); offJoined(); offRoster(); offRejected(); };
  }, [connection, roomId, identity]);

  // Join once, as soon as the socket is open and we know what to say.
  useEffect(() => {
    if (status !== 'open' || sent.current || roomId === '') return;

    const stored = identityRef.current;
    if (stored !== null) {
      sent.current = true;
      connection.joinRoom({
        roomId,
        name: stored.name,
        playerId: stored.playerId,
        token: stored.token,
      });
      return;
    }

    // No stored seat: a first join. Whatever this player last called
    // themselves, if anything — and if nothing, no name at all, which asks the
    // server to name the seat. There is no longer a case where the socket is
    // open and we sit here waiting to be told who we are.
    sent.current = true;
    const remembered = identity.rememberedName();
    connection.joinRoom({
      roomId,
      ...(remembered === null ? {} : { name: remembered }),
    });
  }, [connection, roomId, status, identity]);

  const join = useCallback((name?: string) => {
    if (name !== undefined) identity.rememberName(name);
    sent.current = true;
    setMessage(null);
    connection.joinRoom({
      roomId,
      ...(name === undefined ? {} : { name }),
    });
  }, [connection, roomId, identity]);

  const watch = useCallback((name?: string) => {
    if (name !== undefined) identity.rememberName(name);
    sent.current = true;
    setMessage(null);
    connection.joinRoom({
      roomId,
      spectate: true,
      ...(name === undefined ? {} : { name }),
    });
  }, [connection, roomId, identity]);

  const begin = useCallback(() => { connection.beginGame(); }, [connection]);

  const spectate = useCallback(() => { connection.spectate(); }, [connection]);

  const takeSeat = useCallback(() => { connection.takeSeat(); }, [connection]);

  const rename = useCallback((name: string) => {
    connection.renamePlayer(name);
    // Keep the stored copy current so a refresh rejoins under the new name.
    // The server ignores the name on a token rejoin, but a stale stored name
    // would still surface anywhere the client reads it before the roster
    // arrives.
    const current = identityRef.current;
    if (current !== null) {
      const updated = { ...current, name };
      identityRef.current = updated;
      identity.saveIdentity(roomId, updated);
    }
    identity.rememberName(name);
  }, [connection, roomId, identity]);

  const leaveSeat = useCallback(() => {
    connection.leaveSeat();
    identity.clearIdentity(roomId);
    identityRef.current = null;
  }, [connection, roomId, identity]);

  // Order matters. A roster means we are seated, and a refusal that arrives
  // afterwards ("only the host may begin") is a note to show *in* the lobby —
  // ranking `message` above `roster` would throw a seated player back to a
  // join form over a button they were not allowed to press.
  const phase: LobbyPhase =
    stale ? 'stale'
      : gone ? 'gone'
        : roster !== null ? 'lobby'
          : message !== null ? 'error'
            // Everything below a live socket is `joining`, because an open
            // socket in a room with no roster and no refusal *is* joining:
            // the effect above sends one unconditionally.
              : status !== 'open' ? 'connecting'
                : 'joining';

  return {
    phase, status, roster, playerId, message, gone, stale,
    join, watch, begin, rename, leaveSeat, spectate, takeSeat,
  };
}
