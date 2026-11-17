import {
  filmLayoutFor,
  filmPlaneBoundsFor,
  filmWorldBoundsFor,
} from '@gravllift/halo-infinite-maps';
import { BitReader } from './core/bit-reader';
import type { FilmChunkInput as DecoderChunk } from './core/film-input';
import { inflateChunk, PacketType, splitPackets } from './core/packets';
import { extractBipedCreations } from './decoders/biped-creations';
import { extractDamageEvents, unitAtPredicate } from './decoders/damage-events';
import { extractFireEvents } from './decoders/fire-events';
import { extractInventories } from './decoders/inventory';
import { extractInventoryDeltas } from './decoders/inventory-deltas';
import {
  extractPlayerGameEvents,
  extractPlayerKilledEvents,
} from './decoders/kill-events';
import {
  extractFilmPositions,
  readHighlightEvents,
} from './decoders/positions';
import { extractProjectiles } from './decoders/projectiles';
import { extractStatRecords } from './decoders/stat-records';
import { extractCarryEvents } from './decoders/carry-events';
import { extractWorldObjectScan } from './decoders/world-object-births';
import type {
  FilmChunkInput,
  FilmData,
  FilmHeaderData,
  FilmPlayerData,
  FilmPositionData,
  FilmStatChangeData,
  JsonValue,
} from './film-data';

function readHeader(bytes: Uint8Array): FilmHeaderData {
  const text = (offset: number) => {
    const characters = bytes.subarray(offset, offset + 32);
    const end = characters.indexOf(0);
    const value = String.fromCharCode(
      ...characters.subarray(0, end < 0 ? 32 : end),
    );
    return value && /^[!-~]+$/.test(value) ? value : null;
  };
  const header: FilmHeaderData = {
    build: text(0xcb3f4),
    branch: null,
    started_at: null,
    map_asset_id: null,
    map_version_id: null,
    level: null,
  };
  if (!header.build || !/^[\d.]+$/.test(header.build)) {
    header.build = null;
    return header;
  }
  header.branch = text(0xcb414);
  const reader = new BitReader(bytes);
  const block = 8 * 0xcb45c + 1;
  const asset = block + 8 * (512 + 4 + 12 + 3 * 4096);
  if (asset + 32 * 8 > reader.bitLength) return header;
  const guid = (offset: number) => {
    const value = Array.from({ length: 16 }, (_, index) =>
      reader.peek(offset + index * 8, 8),
    );
    if (value.every((byte) => byte === 0)) return null;
    const hex = (indexes: number[]) =>
      indexes
        .map((index) => value[index].toString(16).padStart(2, '0'))
        .join('');
    return [
      hex([3, 2, 1, 0]),
      hex([5, 4]),
      hex([7, 6]),
      hex([8, 9]),
      hex([10, 11, 12, 13, 14, 15]),
    ].join('-');
  };
  header.started_at =
    Number(reader.peekLittleEndianBytes(block + 512 * 8, 4)) || null;
  header.map_asset_id = guid(asset);
  header.map_version_id = guid(asset + 128);
  const levelBit = 8 * 0xce6a2 + 3;
  if (levelBit + 32 <= reader.bitLength) {
    const level = reader.peek(levelBit, 32);
    header.level = level && level !== 0xffffffff ? level : null;
  }
  return header;
}

const tickAt = (timeMs: number) =>
  Math.max(0, Math.round((timeMs * 60) / 1000));

export async function parseFilm(inputs: FilmChunkInput[]): Promise<FilmData> {
  const indexes = new Set<number>();
  for (const chunk of inputs) {
    if (
      !Number.isInteger(chunk.index) ||
      chunk.index < 0 ||
      chunk.index > 0xffffffff
    )
      throw new Error('Chunk index must be a non-negative integer');
    if (![1, 2, 3].includes(chunk.chunkType))
      throw new Error(`Unknown film chunk type: ${chunk.chunkType}`);
    if (!(chunk.bytes instanceof ArrayBuffer))
      throw new Error('Chunk bytes must be an ArrayBuffer');
    if (indexes.has(chunk.index))
      throw new Error(`Duplicate film chunk ${chunk.index}`);
    indexes.add(chunk.index);
  }
  const chunks: DecoderChunk[] = [...inputs]
    .sort((first, second) => first.index - second.index)
    .map(
      (chunk): DecoderChunk => ({
        index: chunk.index,
        chunkType: chunk.chunkType,
        startTimeOffsetMs: 0,
        durationMs: 0,
        data: new Uint8Array(chunk.bytes),
        fileRelativePath: chunk.fileRelativePath,
      }),
    );
  const registry = chunks.find((chunk) => chunk.chunkType === 1);
  const header = readHeader(
    registry ? inflateChunk(registry.data) : new Uint8Array(),
  );
  const mapId = header.map_asset_id ?? '';
  const bounds = filmPlaneBoundsFor(mapId);
  const world = filmWorldBoundsFor(mapId);
  const highlightEvents = await readHighlightEvents(chunks, 41);
  const owners = await extractBipedCreations(chunks);
  const positions = await extractFilmPositions(chunks, {
    bipedOwners: owners,
    highlightEvents,
    layout: filmLayoutFor(mapId),
    planeBounds: bounds,
    worldBounds: world,
  });
  const players: FilmPlayerData[] = owners.roster.map((player) => ({
    id: player.playerIndex,
    kind: { Human: { xuid: Number(player.xuid), gamertag: player.gamertag } },
    team: null,
    present_at_start: true,
    joined: null,
    left: null,
  }));
  const actorPlayers = new Map<number, number>();
  for (const actor of positions?.actors ?? []) {
    const known = actor.xuid
      ? players.find(
          (player) =>
            'Human' in player.kind &&
            String(player.kind.Human.xuid) === actor.xuid,
        )
      : undefined;
    if (known) {
      actorPlayers.set(actor.actor, known.id);
      continue;
    }
    const id = Math.max(-1, ...players.map((player) => player.id)) + 1;
    actorPlayers.set(actor.actor, id);
    players.push({
      id,
      kind: actor.xuid
        ? {
            Human: {
              xuid: Number(actor.xuid),
              gamertag: actor.gamertag ?? null,
            },
          }
        : { Bot: { bot_id: id, name: actor.gamertag ?? `Player ${id + 1}` } },
      team: actor.team ?? null,
      present_at_start: true,
      joined: null,
      left: null,
    });
  }
  const playerForActor = (
    actor: NonNullable<typeof positions>['actors'][number],
  ) => players.find((player) => player.id === actorPlayers.get(actor.actor));
  const playerAt = (slot: number, timeMs: number) => {
    const actor = positions?.actors.find((actor) =>
      actor.lives.some(
        (life) =>
          life.slot === slot &&
          timeMs >= life.startMs - 1000 &&
          timeMs <= life.endMs + 1000,
      ),
    );
    return actor ? playerForActor(actor)?.id : undefined;
  };
  const toWorld = (point: {
    x: number;
    y: number;
    z: number;
  }): FilmPositionData | null =>
    bounds
      ? {
          x: -10 * (bounds.minY + point.y * (bounds.maxY - bounds.minY)),
          y: 10 * (bounds.minX + point.x * (bounds.maxX - bounds.minX)),
          z: world
            ? 10 * (world.min[2] + point.z * (world.max[2] - world.min[2]))
            : null,
        }
      : null;
  const frameTicks: number[] = [];
  let baseMicros: number | undefined;
  for (const chunk of chunks) {
    if (chunk.chunkType !== 2) continue;
    for (const packet of splitPackets(inflateChunk(chunk.data))) {
      baseMicros ??= packet.timestampMicros;
      if (packet.type === PacketType.Frame)
        frameTicks.push(tickAt((packet.timestampMicros - baseMicros) / 1000));
    }
  }
  const killEvents = await extractPlayerKilledEvents(chunks);
  const kills = killEvents.map((event) => ({
    tick: tickAt(event.timeMs),
    kill: {
      victim: event.victimIndex,
      killer: event.killerIndex < 32 ? event.killerIndex : null,
      killer_damage_percent: event.killerDamagePercent,
      assistant: event.assisterIndex ?? null,
      assistant_damage_percent: event.assisterDamagePercent ?? 0,
      suicide: event.victimIndex === event.killerIndex,
      headshot: null,
      scored: null,
      cause: null,
      weapon: null,
      position: null,
    },
  }));
  const statRecords = await extractStatRecords(chunks);
  const changes: FilmStatChangeData[] = statRecords.flatMap((record) => {
    const owner: FilmStatChangeData['owner'] =
      record.slot === 6 || record.slot === 8
        ? { Team: (record.slot - 6) / 2 }
        : {
            Player:
              owners.roster[(record.slot - 10) / 2]?.playerIndex ??
              (record.slot - 10) / 2,
          };
    if (
      'Player' in owner &&
      (!Number.isInteger(owner.Player) || owner.Player < 0)
    )
      return [];
    return [...record.comps].flatMap(([component, value]) => [
      {
        tick: tickAt(record.timeMs),
        owner,
        slot: component * 2,
        value: value.a,
        round: record.round,
      },
      {
        tick: tickAt(record.timeMs),
        owner,
        slot: component * 2 + 1,
        value: value.b,
        round: record.round,
      },
    ]);
  });
  const events: JsonValue[] = kills.map(({ tick, kill }) => ({
    tick,
    event: { Kill: kill },
  }));
  const fireEvents = await extractFireEvents(chunks);
  for (const event of fireEvents) {
    const player = playerAt(event.slot, event.timeMs);
    if (player !== undefined)
      events.push({
        tick: tickAt(event.timeMs),
        event: {
          Shot: {
            player,
            weapon: event.family,
            yaw:
              event.aimYawDeg === undefined
                ? null
                : ((event.aimYawDeg + 90) * Math.PI) / 180,
          },
        },
      });
  }
  const damageEvents = positions
    ? await extractDamageEvents(chunks, unitAtPredicate(positions))
    : [];
  for (const event of damageEvents) {
    const victim =
      event.victimSlot === undefined
        ? undefined
        : playerAt(event.victimSlot, event.timeMs);
    const attacker =
      event.attackerSlot === undefined
        ? undefined
        : playerAt(event.attackerSlot, event.timeMs);
    if (victim !== undefined)
      events.push({
        tick: tickAt(event.timeMs),
        event: {
          Hit: {
            victim,
            attacker: attacker ?? null,
            damage: null,
            weapon: null,
            shield: 0,
            body: event.magnitude,
            from_vitals: false,
          },
        },
      });
  }
  const playerGameEvents = await extractPlayerGameEvents(chunks);
  for (const event of playerGameEvents) {
    events.push({
      tick: tickAt(event.timeMs),
      event: {
        GameEvent: {
          id: event.type,
          small: 0,
          values: [],
          text: null,
          arguments: [
            { Player: event.killerIndex },
            { Player: event.victimIndex },
          ],
          players: event.recipientMask,
        },
      },
    });
  }
  const inventories = await extractInventories(chunks);
  const deltas = positions
    ? await extractInventoryDeltas(
        chunks,
        positions.layout,
        new Set(positions.tracks.map((track) => track.slot)),
      )
    : [];
  const flights = positions
    ? await extractProjectiles(chunks, positions.layout)
    : [];
  const scan = positions
    ? await extractWorldObjectScan(chunks, positions.layout)
    : { births: [], samples: [], drops: [] };
  const carries = positions
    ? await extractCarryEvents(
        chunks,
        new Set(positions.tracks.map((track) => track.slot)),
      )
    : [];
  const tickDeltas = frameTicks
    .slice(1)
    .map((tick, index) => tick - frameTicks[index]);
  const ticksPerFrame = [1, 2, 3, 4].sort(
    (first, second) =>
      tickDeltas.filter((delta) => delta === second).length -
      tickDeltas.filter((delta) => delta === first).length,
  )[0];
  return {
    header,
    clock: {
      frameCount: frameTicks.length,
      frameTicks,
      end: frameTicks.at(-1) ?? 0,
      ticksPerFrame,
      highlightZero:
        positions?.highlightClockOffsetMs === undefined
          ? null
          : (positions.highlightClockOffsetMs * 60) / 1000,
      hitches: [],
    },
    players,
    variant: null,
    mode: 'Other',
    level:
      world && positions
        ? {
            id: header.level,
            name: '',
            structure: null,
            play: {
              index: 0,
              min: world.min,
              max: world.max,
              widths: positions.layout.axisBits,
            },
            indexBits: positions.layout.gateBits - 4,
            others: [],
          }
        : null,
    coordinates: bounds
      ? {
          source: 'KnownLayout',
          scale_x: (10 * (bounds.maxY - bounds.minY)) / 32768,
          scale_y: (10 * (bounds.maxX - bounds.minX)) / 32768,
          offset_x: -10 * bounds.minY,
          offset_y: 10 * bounds.minX,
          spawn_fit: null,
        }
      : null,
    lives: (positions?.actors ?? []).flatMap((actor) =>
      actor.lives.map((life) => ({
        player: playerForActor(actor)?.id ?? null,
        entity: life.slot,
        died: life.endMs < ((frameTicks.at(-1) ?? 0) * 1000) / 60 - 2000,
        death:
          kills.find(
            ({ tick, kill }) =>
              kill.victim === playerForActor(actor)?.id &&
              Math.abs((tick * 1000) / 60 - life.endMs) < 2000,
          )?.tick ?? null,
        samples: (
          positions?.tracks.find((track) => track.slot === life.slot)
            ?.samples ?? []
        )
          .filter(
            (sample) =>
              sample.timeMs >= life.startMs && sample.timeMs <= life.endMs,
          )
          .map((sample) => ({
            tick: tickAt(sample.timeMs),
            raw: [sample.normalized[0] * 32768, sample.normalized[1] * 32768],
            raw_z: sample.normalized[2] * 32768,
            position: toWorld({
              x: sample.normalized[0],
              y: sample.normalized[1],
              z: sample.normalized[2],
            }),
            yaw:
              sample.aimYawDeg === undefined
                ? null
                : ((sample.aimYawDeg + 90) * Math.PI) / 180,
            facing_yaw:
              sample.facingYawDeg === undefined
                ? null
                : ((sample.facingYawDeg + 90) * Math.PI) / 180,
            pitch:
              sample.aimPitchDeg === undefined
                ? null
                : (sample.aimPitchDeg * Math.PI) / 180,
            health: sample.health ?? null,
            shield: sample.shield ?? null,
            speed: null,
            in_vehicle: false,
            vehicle: null,
          })),
      })),
    ),
    vehicles: [],
    rides: [],
    worldObjects: [],
    groundWeapons: [],
    grenadeFlights: flights.flatMap((flight) => {
      const path: [number, FilmPositionData][] = flight.points.flatMap(
        (point) => {
          const position = toWorld(point);
          return position ? [[tickAt(point.timeMs), position]] : [];
        },
      );
      const player = owners.roster[flight.thrower ?? -1]?.playerIndex;
      return player === undefined || path.length === 0
        ? []
        : [
            {
              player,
              grenade: null,
              path,
              end: tickAt(flight.detonation.timeMs),
              deleted: flight.detonation.fromFilm,
              explodes: flight.explodes,
              lingers: flight.lingers,
            },
          ];
    }),
    zones: [],
    hillScore: null,
    events: events.sort((first, second) => {
      const tick = (value: JsonValue) =>
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof value.tick === 'number'
          ? value.tick
          : 0;
      return tick(first) - tick(second);
    }),
    kills,
    highlights: highlightEvents.map((event) => ({
      player:
        players.find(
          (player) =>
            'Human' in player.kind &&
            String(player.kind.Human.xuid) === event.xuid,
        )?.id ?? null,
      xuid: Number(event.xuid),
      gamertag: event.gamertag,
      kind:
        event.type === 'medal'
          ? { Medal: event.medalType }
          : event.type === 'death'
            ? 'Death'
            : event.type === 'kill'
              ? 'Kill'
              : 'Mode',
      time_ms: event.timeMs,
      tick:
        positions?.highlightClockOffsetMs === undefined
          ? null
          : tickAt(event.timeMs + positions.highlightClockOffsetMs),
    })),
    medals: highlightEvents
      .filter((event) => event.isMedal)
      .map((event) => ({
        tick: null,
        award: {
          player:
            players.find(
              (player) =>
                'Human' in player.kind &&
                String(player.kind.Human.xuid) === event.xuid,
            )?.id ?? null,
          index: event.medalType,
        },
      })),
    scoreboard: { changes, clock: [], engine: [] },
    states: players.map((player) => ({
      playerId: player.id,
      state: {
        inputs: [],
        ammo: [],
        energy: [],
        heat: [],
        grenades: [],
        equipment: [],
      },
    })),
    records: {
      roster: owners.roster,
      highlightEvents,
      statRecords: statRecords.map((record) => ({
        ...record,
        comps: [...record.comps],
      })),
      inventories,
      inventoryDeltas: deltas,
      fireEvents,
      damageEvents,
      killEvents,
      playerGameEvents,
      flights,
      worldObjects: scan,
      carryEvents: carries,
    },
  };
}
