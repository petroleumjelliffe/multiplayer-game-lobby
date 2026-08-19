import { io, type Socket } from 'socket.io-client';
import {
  LOBBY_CLIENT_EVENTS,
  LOBBY_SERVER_EVENTS,
  type CreateRoomMessage,
  type JoinRoomMessage,
  type RenamePlayerMessage,
  type JoinedMessage,
  type RosterMessage,
  type RejectedMessage,
} from '../protocol/protocol';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export interface LobbyConnectionOptions {
  serverUrl: string;
  protocolVersion: number;
  /** socket.io mount path, e.g. '/railbaron/socket.io', for a client served
   *  behind a path proxy. Absent means socket.io's own '/socket.io' —
   *  today's behaviour, and right for a server that owns its whole origin. */
  socketPath?: string;
}

/**
 * The lobby half of the wire: create/join/roster/rename/leave, plus the raw
 * socket a game hangs its own transport off of.
 *
 * Untested in isolation, deliberately: `server/clientOverWire.test.ts` proves
 * the wire against the real server, and the create/join/start path is
 * covered by the by-hand pass. A test that stubs `io()` and asserts `emit`
 * was called would restate this file rather than check it.
 */
export interface LobbyConnection {
  /** The raw socket, exposed so a game can hang its own transport off it. */
  socket: Socket;
  status(): ConnectionStatus;
  /** Fires on every status change. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Omit the name to be seated under a seat-derived default. */
  createRoom(name?: string): void;
  joinRoom(msg: Omit<JoinRoomMessage, 'protocolVersion'>): void;
  beginGame(): void;
  /** Rename your own seat. Lobby-only; the server enforces it. */
  renamePlayer(name: string): void;
  /** Give up your own seat. Lobby-only; mid-game leaving is a disconnect.
   *  For a spectator: stop watching, in any lifecycle. */
  leaveSeat(): void;
  /**
   * Give up your seat but stay to watch. Non-host only; the lobby always
   * allows it, mid-game only a game that opted in does — the server enforces
   * both, and a fresh `joined` delivers the watcher's new identity.
   */
  spectate(): void;
  /** A spectator claims a free seat. Lobby-only; the server enforces it. */
  takeSeat(): void;
  onJoined(handler: (msg: JoinedMessage) => void): () => void;
  onRoster(handler: (msg: RosterMessage) => void): () => void;
  /**
   * Shares the socket's `rejected` event with `src/net/transport.ts`'s
   * `onRejected` — one channel, two subscribers. This side branches on the
   * lobby's own codes (`noSuchRoom`, `versionMismatch`, …); the game side
   * interprets whatever it doesn't recognize. A subscriber added on either
   * side is heard by both.
   */
  onRejected(handler: (msg: RejectedMessage) => void): () => void;
  close(): void;
}

export function createLobbyConnection(opts: LobbyConnectionOptions): LobbyConnection {
  const socket: Socket = io(opts.serverUrl, {
    // `undefined` here is socket.io's own default ('/socket.io'), so an
    // absent option changes nothing for a server that owns its whole origin.
    path: opts.socketPath,
    transports: ['websocket'],
    // Stated rather than inherited, so the reconnect behaviour is this file's
    // decision and not a dependency's default.
    //
    // The original justification was a cold start: "a sleeping Render free
    // instance takes ~30s to wake, so the first attempt times out at 20s and
    // it is the retry that actually lands." **That premise is wrong** — the
    // service is on Render's paid `starter` plan (confirmed 2026-08-08), and
    // paid instances do not spin down. There is no routine 30s wake to
    // survive.
    //
    // The settings stay anyway, because what they actually buy is surviving a
    // *deploy* — the instance restarts, every socket drops, and infinite
    // retries with a capped backoff are what bring the room back. That is a
    // real event on every push, unlike the cold start this was written for.
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    timeout: 20000,
  });
  const listeners = new Set<() => void>();
  let status: ConnectionStatus = 'connecting';

  function set(next: ConnectionStatus): void {
    status = next;
    for (const listener of listeners) listener();
  }

  socket.on('connect', () => { set('open'); });
  socket.on('disconnect', () => { set('closed'); });
  socket.io.on('reconnect_attempt', () => { set('connecting'); });

  return {
    socket,
    status: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    createRoom(name) {
      // Sent only when there is one. An absent `name` is what tells the
      // server to name this seat itself; sending `undefined` explicitly would
      // serialise to the same thing, but saying it once here keeps the wire
      // shape and the type in agreement.
      const msg: CreateRoomMessage = name === undefined
        ? { protocolVersion: opts.protocolVersion }
        : { name, protocolVersion: opts.protocolVersion };
      socket.emit(LOBBY_CLIENT_EVENTS.createRoom, msg);
    },
    joinRoom(msg) {
      const wire: JoinRoomMessage = { ...msg, protocolVersion: opts.protocolVersion };
      socket.emit(LOBBY_CLIENT_EVENTS.joinRoom, wire);
    },
    beginGame() { socket.emit(LOBBY_CLIENT_EVENTS.beginGame); },
    renamePlayer(name) {
      const msg: RenamePlayerMessage = { name };
      socket.emit(LOBBY_CLIENT_EVENTS.renamePlayer, msg);
    },
    leaveSeat() { socket.emit(LOBBY_CLIENT_EVENTS.leaveSeat); },
    spectate() { socket.emit(LOBBY_CLIENT_EVENTS.spectate); },
    takeSeat() { socket.emit(LOBBY_CLIENT_EVENTS.takeSeat); },
    onJoined(handler) {
      socket.on(LOBBY_SERVER_EVENTS.joined, handler);
      return () => { socket.off(LOBBY_SERVER_EVENTS.joined, handler); };
    },
    onRoster(handler) {
      socket.on(LOBBY_SERVER_EVENTS.roster, handler);
      return () => { socket.off(LOBBY_SERVER_EVENTS.roster, handler); };
    },
    onRejected(handler) {
      socket.on(LOBBY_SERVER_EVENTS.rejected, handler);
      return () => { socket.off(LOBBY_SERVER_EVENTS.rejected, handler); };
    },
    close() {
      socket.disconnect();
      listeners.clear();
    },
  };
}
