import { describe, expect, it } from 'vitest';
import { createLobbyRegistry, seatPlayer, type LobbyRoomLike, type SeatHolder } from './rooms.js';
import type { Lifecycle } from '../protocol/protocol.js';

interface StubRoom extends LobbyRoomLike { stage: Lifecycle }

const makeStub = (id: string, players: SeatHolder[]): StubRoom => ({
  id,
  players,
  stage: 'lobby',
  lifecycle() { return this.stage; },
});

const SPACE = { ids: ['p1', 'p2', 'p3'] };
const registry = () => createLobbyRegistry<StubRoom>(makeStub, SPACE);

describe('seating from a fixed id space', () => {
  it('gives the host the first id', () => {
    const { player } = registry().create('Ada');
    expect(player.id).toBe('p1');
    expect(player.isHost).toBe(true);
  });

  it('hands each new arrival the next free id', () => {
    const r = registry();
    const { room } = r.create('Ada');
    expect(r.join(room.id, 'Margo')?.player.id).toBe('p2');
    expect(r.join(room.id, 'Dev')?.player.id).toBe('p3');
  });

  it('reuses a vacated id instead of minting a duplicate', () => {
    // The bug this whole change exists for: ids used to come from
    // players.length, which shrinks when leaveSeat splices the array.
    const r = registry();
    const { room } = r.create('Ada');
    r.join(room.id, 'Margo');
    r.join(room.id, 'Dev');

    room.players.splice(1, 1);            // p2 leaves, exactly as leaveSeat does
    const rejoined = r.join(room.id, 'Kit');

    expect(rejoined?.player.id).toBe('p2');
    expect(room.players.map((p) => p.id)).toEqual(['p1', 'p3', 'p2']);
    expect(new Set(room.players.map((p) => p.id)).size).toBe(room.players.length);
  });

  it('does not make a second host when the first seat is retaken', () => {
    // leaveSeat promotes players[0] when the host goes; a newcomer taking the
    // freed p1 must not arrive believing it is host as well.
    const r = registry();
    const { room } = r.create('Ada');
    r.join(room.id, 'Margo');

    room.players.splice(0, 1);            // the host leaves
    room.players[0]!.isHost = true;       // ...and the handler promotes the next
    r.join(room.id, 'Dev');               // who then takes the freed p1

    expect(room.players.filter((p) => p.isHost)).toHaveLength(1);
    expect(room.players.find((p) => p.isHost)?.name).toBe('Margo');
  });

  it('refuses a join once every seat is taken', () => {
    const r = registry();
    const { room } = r.create('Ada');
    r.join(room.id, 'Margo');
    r.join(room.id, 'Dev');
    expect(r.join(room.id, 'Kit')).toBeNull();
  });

  it('names an unnamed arrival after the seat they actually got', () => {
    const r = registry();
    const { room } = r.create('Ada');
    r.join(room.id, 'Margo');
    room.players.splice(1, 1);
    expect(r.join(room.id)?.player.name).toBe('Player 2');
  });

  it('lets a game supply its own ids and default names', () => {
    // Rail Baron's seats are colours, and the colour *is* the id — which is
    // why the lobby needs no badge field: the decoration is the identity.
    const space = { ids: ['red', 'green'], defaultName: (i: number) => `Baron ${i + 1}` };
    const r = createLobbyRegistry<StubRoom>(makeStub, space);
    const { room, player } = r.create();
    expect(player.id).toBe('red');
    expect(player.name).toBe('Baron 1');
    expect(r.join(room.id)?.player.id).toBe('green');
  });

  it('seats nobody into a space with no ids, rather than inventing one', () => {
    expect(seatPlayer({ ids: [] }, [], 'Ada')).toBeNull();
  });
});

describe('spectating', () => {
  it('converting frees the seat id for the next arrival', () => {
    const r = registry();
    const { room } = r.create('Ada');
    const margo = r.join(room.id, 'Margo')!.player;

    const converted = r.spectate(room.id, margo.id)!;
    expect(converted.vacatedSeatId).toBe('p2');
    expect(r.join(room.id, 'Dev')?.player.id).toBe('p2');
  });

  it('a converted player keeps the name but nothing else of the seat', () => {
    // The old seat's credentials die with the seat: a spectator id lives
    // outside the seat space, and the old token must not open anything.
    const r = registry();
    const { room } = r.create('Ada');
    const margo = r.join(room.id, 'Margo')!.player;

    const { seated } = r.spectate(room.id, margo.id)!;
    expect(seated.role).toBe('spectator');
    expect(seated.player.name).toBe('Margo');
    expect(SPACE.ids).not.toContain(seated.player.id);
    expect(seated.player.token).not.toBe(margo.token);
    expect(r.join(room.id, undefined, margo.id, margo.token)).toBeNull();
  });

  it('a spectator rejoin must present its own token, like a seat', () => {
    const r = registry();
    const { room } = r.create('Ada');
    const bee = r.joinAsSpectator(room.id, 'Bee')!.player;

    expect(r.join(room.id, undefined, bee.id, 'wrong-token')).toBeNull();
    const back = r.join(room.id, undefined, bee.id, bee.token)!;
    expect(back.role).toBe('spectator');
    expect(back.player.id).toBe(bee.id);
  });

  it('watching a full or started room always works — no capacity, any lifecycle', () => {
    const r = registry();
    const { room } = r.create('Ada');
    r.join(room.id, 'Margo');
    r.join(room.id, 'Dev');
    room.stage = 'playing';

    expect(r.join(room.id, 'Kit')).toBeNull();
    const kit = r.joinAsSpectator(room.id, 'Kit');
    expect(kit?.role).toBe('spectator');
    expect(room.spectators).toHaveLength(1);
  });

  it('names an unnamed watcher by headcount', () => {
    const r = registry();
    const { room } = r.create('Ada');
    expect(r.joinAsSpectator(room.id)?.player.name).toBe('Spectator 1');
    expect(r.joinAsSpectator(room.id)?.player.name).toBe('Spectator 2');
  });

  it('takeSeat is the exact reverse, into the freed id', () => {
    const r = registry();
    const { room } = r.create('Ada');
    const margo = r.join(room.id, 'Margo')!.player;
    r.spectate(room.id, margo.id);

    const spectatorId = room.spectators![0]!.id;
    const seated = r.takeSeat(room.id, spectatorId)!;
    expect(seated.role).toBe('player');
    expect(seated.player.id).toBe('p2');
    expect(seated.player.name).toBe('Margo');
    expect(room.spectators).toHaveLength(0);
  });

  it('takeSeat refuses a full room and keeps the watcher watching', () => {
    const r = registry();
    const { room } = r.create('Ada');
    r.join(room.id, 'Margo');
    r.join(room.id, 'Dev');
    const bee = r.joinAsSpectator(room.id, 'Bee')!.player;

    expect(r.takeSeat(room.id, bee.id)).toBeNull();
    expect(room.spectators).toHaveLength(1);
  });

  it('a watcher seated into an empty room becomes host, so the lobby can start', () => {
    const r = registry();
    const { room } = r.create('Ada');
    const bee = r.joinAsSpectator(room.id, 'Bee')!.player;
    room.players.splice(0, 1); // everyone left; only Bee remains, watching

    expect(r.takeSeat(room.id, bee.id)?.player.isHost).toBe(true);
  });
});
