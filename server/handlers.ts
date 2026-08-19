// server/lobby/handlers.ts
// The five lobby socket handlers plus the disconnect presence handler, and
// the socket<->seat bindings they share. Generic over the room the game
// builds: this file only ever touches what `LobbyRoomLike` promises.

import type { Server as SocketServer, Socket } from 'socket.io';
import {
  LOBBY_CLIENT_EVENTS,
  LOBBY_SERVER_EVENTS,
  type CreateRoomMessage,
  type JoinRoomMessage,
  type JoinedMessage,
  type RenamePlayerMessage,
  type RosterMessage,
} from '../protocol/protocol.js';
import { spectatorsOf, type LobbyRegistry, type LobbyRoomLike, type Seated } from './rooms.js';

/**
 * Which room and standing a socket is bound to. The client never says.
 * `role` is what a game's projection layer branches on before sending
 * anything a spectator must not see; a spectator's `playerId` names their
 * entry in `room.spectators`, never a seat.
 */
export interface SeatBinding {
  roomId: string;
  playerId: string;
  role: 'player' | 'spectator';
}

export interface LobbyHooks<R extends LobbyRoomLike> {
  protocolVersion: number;
  /**
   * The host pressed begin; the lobby has already verified host and
   * lifecycle. The game starts itself and owns the send order — call
   * `wiring.broadcastRoster` yourself when the moment is right.
   */
  onBegin(room: R): void;
  /** A socket was seated (first join or rejoin), `joined` + roster already sent. */
  onSeated(room: R, playerId: string): void;
  /**
   * A socket became a spectator (direct join, rejoin, or a seated player
   * converting), `joined` + roster already sent. Send them your game's
   * *public* state — a spectator sees everything except hidden hands, and
   * this hook is where that projection happens. Required, deliberately: a
   * game that ignores it ships spectators who see nothing, and this repo
   * prefers that to be a compile error at the submodule bump.
   *
   * `vacatedSeatId` names the seat a converting player just gave up — null
   * for a direct arrival. A game that allows mid-game conversion reads it to
   * handle the emptied seat; in the lobby the roster broadcast already said
   * everything.
   */
  onSpectate(room: R, spectatorId: string, vacatedSeatId: string | null): void;
  /**
   * May this seated player convert to a spectator while the game is running?
   * Absent means no — mid-game conversion is opt-in, because it empties a
   * seat the game must then cope with (skipped turns, forfeits: the game's
   * ruling, made here). Consulted only in the `playing` lifecycle; the lobby
   * always allows conversion, and a finished game refuses it.
   */
  allowMidgameSpectate?(room: R, playerId: string): boolean;
}

export interface LobbyWiring<R extends LobbyRoomLike> {
  seatOf(socketId: string): SeatBinding | undefined;
  socketsFor(roomId: string, playerId: string): Socket[];
  broadcastRoster(room: R): void;
  /** Register the lobby's handlers on one connection. Call from io.on('connection'). */
  attach(socket: Socket): void;
}

export function createLobbyHandlers<R extends LobbyRoomLike>(
  io: SocketServer,
  registry: Pick<
    LobbyRegistry<R>,
    'create' | 'join' | 'get' | 'joinAsSpectator' | 'spectate' | 'takeSeat'
  >,
  hooks: LobbyHooks<R>,
): LobbyWiring<R> {
  const bindings = new Map<string, SeatBinding>();

  function socketsFor(roomId: string, playerId: string): Socket[] {
    return [...io.sockets.sockets.values()].filter((s) => {
      const b = bindings.get(s.id);
      return b?.roomId === roomId && b.playerId === playerId;
    });
  }

  function roster(room: R): RosterMessage {
    return {
      roomId: room.id,
      lifecycle: room.lifecycle(),
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        isHost: p.isHost,
        connected: p.connected,
      })),
      spectators: spectatorsOf(room).map((s) => ({
        id: s.id,
        name: s.name,
        connected: s.connected,
      })),
    };
  }

  function broadcastRoster(room: R): void {
    io.to(room.id).emit(LOBBY_SERVER_EVENTS.roster, roster(room));
  }

  function attach(socket: Socket): void {
    /**
     * Whether this client speaks our protocol, answering the socket if not.
     *
     * Equality, not "at least": the client ships to GitHub Pages and the
     * server to Render, independently, so the client can perfectly well be
     * the *newer* side. A `>=` check here would wave that case through and
     * then fail somewhere deep in a handler, presenting as a game bug.
     *
     * Absent is a mismatch. Clients built before this existed send nothing,
     * and they are precisely what this is for.
     */
    function speaksOurProtocol(version: unknown): boolean {
      if (version === hooks.protocolVersion) return true;
      socket.emit(LOBBY_SERVER_EVENTS.rejected, {
        code: 'versionMismatch',
        message:
          `This client speaks protocol ${String(version)}; this server speaks ${hooks.protocolVersion}`,
      });
      return false;
    }

    socket.on(LOBBY_CLIENT_EVENTS.createRoom, (msg: CreateRoomMessage) => {
      // Before the shape check below, and before anything is created: a
      // client we cannot talk to must not leave a room behind, because an
      // abandoned room is persisted and restored at the next boot.
      if (!speaksOurProtocol(msg?.protocolVersion)) return;

      // `msg` is whatever the client sent, typed only by wishful thinking —
      // a malformed or missing payload dereferenced below would throw
      // synchronously inside this listener and take the whole process down
      // for every room, not just this connection. This socket has not even
      // bound to a room yet, so any connecting client can reach this line.
      // An *absent* name is ordinary — no card asks for one before seating
      // you, and `rooms.create` names you by your seat. A name of the wrong
      // *type* is still a malformed payload and still refused: this listener
      // is reachable by any connected socket before it has bound to a room,
      // so a throw here takes down every room in the process, not just this
      // connection.
      if (msg?.name !== undefined && typeof msg.name !== 'string') {
        socket.emit(LOBBY_SERVER_EVENTS.rejected, {
          code: 'unknownIntent',
          message: 'createRoom name must be text',
        });
        return;
      }

      const { room, player } = registry.create(msg.name);
      bindings.set(socket.id, { roomId: room.id, playerId: player.id, role: 'player' });
      void socket.join(room.id);

      const joined: JoinedMessage = { roomId: room.id, playerId: player.id, token: player.token };
      socket.emit(LOBBY_SERVER_EVENTS.joined, joined);
      io.to(room.id).emit(LOBBY_SERVER_EVENTS.roster, roster(room));
    });

    socket.on(LOBBY_CLIENT_EVENTS.joinRoom, (msg: JoinRoomMessage) => {
      // Before the room lookup, so a stale client is told it is stale rather
      // than told the room does not exist — which would send the player
      // hunting for a room that is perfectly fine.
      if (!speaksOurProtocol(msg?.protocolVersion)) return;

      // Same shape hazard as `createRoom`, above: this socket has not bound
      // to anything yet either, so a malformed payload here is just as
      // reachable by any connecting client.
      // The roomId is still required — there is nothing to look up without
      // it. The name is not, for the same reason as `createRoom` above, and
      // a non-string one is refused for the same reason too.
      if (typeof msg?.roomId !== 'string' || (msg.name !== undefined && typeof msg.name !== 'string')) {
        socket.emit(LOBBY_SERVER_EVENTS.rejected, {
          code: 'unknownIntent',
          message: 'joinRoom requires a roomId, and a name must be text if given',
        });
        return;
      }

      const target = registry.get(msg.roomId);
      if (!target) {
        socket.emit(LOBBY_SERVER_EVENTS.rejected, {
          code: 'noSuchRoom',
          message: `Room ${msg.roomId} is no longer available`,
        });
        return;
      }

      // One socket holds one seat per room.
      //
      // A `joinRoom` with no `playerId`/`token` seats a *new* player — that is
      // what makes a first join work, and it is why a second one from the same
      // socket used to seat a second. Found by hand: two browsers produced a
      // three-player roster, and the orphaned seat is one the game waits on
      // forever when its turn comes, because nobody is behind it.
      //
      // A client cannot reliably prevent this on its own. It has no token to
      // present until its own `joined` reply lands, so a socket blip during
      // that window leaves it re-joining as a stranger with no way to say who
      // it already is. The binding this server already keeps is the answer:
      // if this socket is bound to a seat in the room it is asking to join,
      // that seat is the answer to the request.
      let seat: Seated<R> | null = null;
      const bound = bindings.get(socket.id);
      if (bound && bound.roomId === msg.roomId) {
        const standing =
          bound.role === 'spectator'
            ? spectatorsOf(target).find((s) => s.id === bound.playerId)
            : target.players.find((p) => p.id === bound.playerId);
        if (standing) seat = { room: target, player: standing, role: bound.role };
      }

      // An explicit ask to watch never reaches `join`: that path holds the
      // honor-system name reclaim, and someone asking to spectate must not
      // capture an abandoned seat that happens to share their name. A stored
      // identity still rejoins first — a returning watcher keeps who they
      // were rather than minting a second row — and only a stale or absent
      // one falls through to a fresh spectator entry, which works in any
      // lifecycle: watching is what a full or started room still offers.
      if (msg.spectate === true) {
        seat ??= msg.playerId
          ? registry.join(msg.roomId, msg.name, msg.playerId, msg.token)
          : null;
        seat ??= registry.joinAsSpectator(msg.roomId, msg.name);
      } else {
        seat ??= registry.join(msg.roomId, msg.name, msg.playerId, msg.token);
      }

      if (!seat) {
        socket.emit(LOBBY_SERVER_EVENTS.rejected, {
          code: 'seatRefused',
          message: `That seat in ${msg.roomId} is no longer yours — join again to take a new one`,
        });
        return;
      }

      seat.player.connected = true;

      bindings.set(socket.id, {
        roomId: seat.room.id,
        playerId: seat.player.id,
        role: seat.role,
      });
      void socket.join(seat.room.id);

      const joined: JoinedMessage = {
        roomId: seat.room.id,
        playerId: seat.player.id,
        token: seat.player.token,
      };
      socket.emit(LOBBY_SERVER_EVENTS.joined, joined);
      io.to(seat.room.id).emit(LOBBY_SERVER_EVENTS.roster, roster(seat.room));

      if (seat.role === 'spectator') hooks.onSpectate(seat.room, seat.player.id, null);
      else hooks.onSeated(seat.room, seat.player.id);
    });

    socket.on(LOBBY_CLIENT_EVENTS.renamePlayer, (msg: RenamePlayerMessage) => {
      const bound = bindings.get(socket.id);
      const room = bound && registry.get(bound.roomId);
      if (!bound || !room) {
        socket.emit(LOBBY_SERVER_EVENTS.rejected, {
          code: 'notConnected',
          message: 'No seat to rename — join a room first',
        });
        return;
      }
      // Lobby-only *for players*: the engine copies names into `GameState` at
      // startGame, and a rename after that leaves the roster and the log
      // disagreeing about who did what. A spectator's name lives only on the
      // roster — no game state ever copies it — so a mid-game watcher who
      // arrived as "Spectator 3" may still say who they are.
      if (bound.role === 'player' && room.lifecycle() !== 'lobby') {
        socket.emit(LOBBY_SERVER_EVENTS.rejected, {
          code: 'wrongStage',
          message: 'Names are settled once the game starts',
        });
        return;
      }
      const name = typeof msg?.name === 'string' ? msg.name.trim() : '';
      if (name === '') {
        socket.emit(LOBBY_SERVER_EVENTS.rejected, {
          code: 'unknownIntent',
          message: 'renamePlayer requires a name',
        });
        return;
      }

      // The binding names the seat; the payload cannot rename anyone else.
      const holder =
        bound.role === 'spectator'
          ? spectatorsOf(room).find((s) => s.id === bound.playerId)
          : room.players.find((p) => p.id === bound.playerId);
      if (!holder) return;
      holder.name = name;
      io.to(room.id).emit(LOBBY_SERVER_EVENTS.roster, roster(room));
    });

    socket.on(LOBBY_CLIENT_EVENTS.leaveSeat, () => {
      const bound = bindings.get(socket.id);
      const room = bound && registry.get(bound.roomId);
      if (!bound || !room) return;

      // A spectator holds no seat, so leaving costs the game nothing and is
      // allowed in any lifecycle — unlike a seat, which a started game keeps.
      if (bound.role === 'spectator') {
        const watchers = spectatorsOf(room);
        const at = watchers.findIndex((s) => s.id === bound.playerId);
        if (at !== -1) watchers.splice(at, 1);
        bindings.delete(socket.id);
        void socket.leave(room.id);
        io.to(room.id).emit(LOBBY_SERVER_EVENTS.roster, roster(room));
        return;
      }

      // Mid-game leaving is a disconnect, which keeps the seat and marks it
      // away — the game waits. Only a lobby seat can be given up.
      if (room.lifecycle() !== 'lobby') {
        socket.emit(LOBBY_SERVER_EVENTS.rejected, {
          code: 'wrongStage',
          message: 'A started game keeps its seats — closing the tab is enough',
        });
        return;
      }

      const at = room.players.findIndex((p) => p.id === bound.playerId);
      if (at === -1) return;
      const wasHost = room.players[at]!.isHost;
      room.players.splice(at, 1);
      // A lobby with no host is a lobby nobody can ever start.
      if (wasHost && room.players.length > 0) room.players[0]!.isHost = true;

      bindings.delete(socket.id);
      void socket.leave(room.id);
      io.to(room.id).emit(LOBBY_SERVER_EVENTS.roster, roster(room));
    });

    socket.on(LOBBY_CLIENT_EVENTS.spectate, () => {
      const bound = bindings.get(socket.id);
      const room = bound && registry.get(bound.roomId);
      if (!bound || !room) {
        socket.emit(LOBBY_SERVER_EVENTS.rejected, {
          code: 'notConnected',
          message: 'No seat to give up — join a room first',
        });
        return;
      }
      // Already watching: there is nothing to convert, and nothing to say.
      if (bound.role === 'spectator') return;

      const player = room.players.find((p) => p.id === bound.playerId);
      if (!player) return;
      if (player.isHost) {
        socket.emit(LOBBY_SERVER_EVENTS.rejected, {
          code: 'notYourTurn',
          message: 'the host cannot spectate — leave instead, which hands the lobby to the next player',
        });
        return;
      }

      // The lobby always allows conversion; mid-game is the game's ruling
      // (`allowMidgameSpectate`), because it empties a seat the game must
      // then cope with; a finished game has nothing left to watch for.
      const stage = room.lifecycle();
      const allowed =
        stage === 'lobby' ||
        (stage === 'playing' && hooks.allowMidgameSpectate?.(room, player.id) === true);
      if (!allowed) {
        socket.emit(LOBBY_SERVER_EVENTS.rejected, {
          code: 'wrongStage',
          message:
            stage === 'playing'
              ? 'this game keeps its players once it begins'
              : 'the game is over — there is nothing left to watch',
        });
        return;
      }

      const converted = registry.spectate(room.id, player.id);
      if (!converted) return;
      const { seated, vacatedSeatId } = converted;

      // Every socket this player holds converts with them — two tabs were one
      // seat and are now one watcher — and each is told its new identity,
      // which the client's ordinary `joined` handling stores over the old.
      const joined: JoinedMessage = {
        roomId: room.id,
        playerId: seated.player.id,
        token: seated.player.token,
      };
      for (const held of socketsFor(room.id, bound.playerId)) {
        bindings.set(held.id, { roomId: room.id, playerId: seated.player.id, role: 'spectator' });
        held.emit(LOBBY_SERVER_EVENTS.joined, joined);
      }

      io.to(room.id).emit(LOBBY_SERVER_EVENTS.roster, roster(room));
      hooks.onSpectate(room, seated.player.id, vacatedSeatId);
    });

    socket.on(LOBBY_CLIENT_EVENTS.takeSeat, () => {
      const bound = bindings.get(socket.id);
      const room = bound && registry.get(bound.roomId);
      if (!bound || !room) {
        socket.emit(LOBBY_SERVER_EVENTS.rejected, {
          code: 'notConnected',
          message: 'Not watching a room — join one first',
        });
        return;
      }
      // Already seated: there is nothing to claim.
      if (bound.role !== 'spectator') return;

      if (room.lifecycle() !== 'lobby') {
        socket.emit(LOBBY_SERVER_EVENTS.rejected, {
          code: 'wrongStage',
          message: 'a started game deals no new seats',
        });
        return;
      }

      const seat = registry.takeSeat(room.id, bound.playerId);
      if (!seat) {
        socket.emit(LOBBY_SERVER_EVENTS.rejected, {
          code: 'seatRefused',
          message: 'every seat is taken',
        });
        return;
      }

      const joined: JoinedMessage = {
        roomId: room.id,
        playerId: seat.player.id,
        token: seat.player.token,
      };
      for (const held of socketsFor(room.id, bound.playerId)) {
        bindings.set(held.id, { roomId: room.id, playerId: seat.player.id, role: 'player' });
        held.emit(LOBBY_SERVER_EVENTS.joined, joined);
      }

      io.to(room.id).emit(LOBBY_SERVER_EVENTS.roster, roster(room));
      hooks.onSeated(room, seat.player.id);
    });

    socket.on(LOBBY_CLIENT_EVENTS.beginGame, () => {
      const bound = bindings.get(socket.id);
      const room = bound && registry.get(bound.roomId);
      if (!bound || !room) return;

      const host = room.players.find((p) => p.isHost);
      if (host?.id !== bound.playerId) {
        socket.emit(LOBBY_SERVER_EVENTS.rejected, {
          code: 'notYourTurn',
          message: 'only the host may begin the game',
        });
        return;
      }

      // `room.dispatch`, `room.undo` and `room.begin` all THROW rather than
      // reject outside their expected lifecycle, and socket.io does not catch
      // a synchronous throw from a listener — an unguarded call here takes
      // the whole process down for every room, not just this one. These three
      // checks (here, and in `intent` and `undo` below) exist to turn that
      // crash into a clean rejection; they are not redundant with anything
      // upstream.
      if (room.lifecycle() !== 'lobby') {
        socket.emit(LOBBY_SERVER_EVENTS.rejected, {
          code: 'wrongStage',
          message: 'the game has already begun',
        });
        return;
      }

      hooks.onBegin(room);
    });

    socket.on('disconnect', () => {
      const bound = bindings.get(socket.id);
      bindings.delete(socket.id);
      if (!bound) return;

      const room = registry.get(bound.roomId);
      if (!room) return;
      // Presence only, and deliberately thin: the game simply waits. Reconnect
      // handling is Phase 4's.
      if (socketsFor(room.id, bound.playerId).length === 0) {
        const holder =
          bound.role === 'spectator'
            ? spectatorsOf(room).find((s) => s.id === bound.playerId)
            : room.players.find((p) => p.id === bound.playerId);
        if (holder) holder.connected = false;
        io.to(room.id).emit(LOBBY_SERVER_EVENTS.roster, roster(room));
      }
    });
  }

  return {
    seatOf: (socketId) => bindings.get(socketId),
    socketsFor,
    broadcastRoster,
    attach,
  };
}
