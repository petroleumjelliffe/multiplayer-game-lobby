// A room that is not GameRoom. If the lobby's generics ever grow a requirement
// only GameRoom satisfies, this file is what goes red — before the lift does.
import { createLobbyRegistry, seatPlayer, type LobbyRoomLike, type SeatHolder } from './rooms.js';
import type { LobbyHooks } from './handlers.js';
import type { Lifecycle } from '../protocol/protocol.js';

interface StubRoom extends LobbyRoomLike { begun: boolean }

// Deliberately nothing like Acquire's `p1…p6`. This file exists to catch the
// lobby growing a requirement only GameRoom satisfies, and a seat space that
// looked like Acquire's would hide exactly that.
const STUB_SEATS = { ids: ['seat-a', 'seat-b', 'seat-c'] };

function makeStub(id: string, players: SeatHolder[]): StubRoom {
  const lifecycle: Lifecycle = 'lobby';
  return { id, players, lifecycle: () => lifecycle, begun: false };
}

// Compile-time proof the hook types instantiate over a non-GameRoom room.
// `onSpectate` is required on purpose: a game that ignores it ships
// spectators who see nothing, and this repo prefers the omission to be a
// compile error at the submodule bump. `allowMidgameSpectate` stays absent
// here — mid-game conversion is opt-in, and a consumer without it compiling
// is the proof of that.
const _hooks: LobbyHooks<StubRoom> = {
  protocolVersion: 1,
  onBegin: (room) => { room.begun = true; },
  onSeated: () => {},
  onSpectate: () => {},
};
void _hooks;

describe('the registry over a room that is not GameRoom', () => {
  it('creates, seats the host, and names an unnamed second seat by number', () => {
    const registry = createLobbyRegistry<StubRoom>(makeStub, STUB_SEATS);
    const { room, player: host } = registry.create('Ada');
    expect(host.isHost).toBe(true);
    expect(host.name).toBe('Ada');

    const seated = registry.join(room.id);
    expect(seated?.player.name).toBe('Player 2');
    expect(registry.get(room.id)?.players).toHaveLength(2);
  });

  it('a rejoin must present the seat\'s own token', () => {
    const registry = createLobbyRegistry<StubRoom>(makeStub, STUB_SEATS);
    const { room, player } = registry.create('Ada');
    expect(registry.join(room.id, undefined, player.id, 'wrong-token')).toBeNull();
    expect(registry.join(room.id, undefined, player.id, player.token)?.player.id).toBe(player.id);
  });

  it('adopt replaces whatever holds the id', () => {
    const registry = createLobbyRegistry<StubRoom>(makeStub, STUB_SEATS);
    const replacement = makeStub('ABC123', [seatPlayer(STUB_SEATS, [], 'Bee')!]);
    registry.adopt(replacement);
    expect(registry.get('ABC123')).toBe(replacement);
  });
});
