import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { BitReader } from "./core/bit-reader";
import { pitchDegrees, readBipedComponents, yawDegrees } from "./core/components";
import { findBipedSlots } from "./core/biped-records";
import { bindPlayers } from "./players/bind-players";
import { linkLives } from "./players/link-lives";
import { createReplay } from "./timeline/replay";
import { buildScoreTimeline, scoreAt } from "./timeline/score";
import type { StatRecord } from "./decoders/stat-records";
import { PacketType, splitPackets } from "./core/packets";
import type { FilmChunkInput } from "./core/film-input";
import { parseFilm } from "./parse-film";
import { parseRoster } from "./decoders/roster";

class BitWriter {
  private bits: number[] = [];

  public write(value: number | bigint, count: number): this {
    const v = BigInt(value);
    for (let i = count - 1; i >= 0; i--) {
      this.bits.push(Number((v >> BigInt(i)) & 1n));
    }
    return this;
  }

  public writeLittleEndian(value: bigint, bytes: number): this {
    for (let k = 0; k < bytes; k++) {
      this.write((value >> BigInt(8 * k)) & 0xffn, 8);
    }
    return this;
  }

  public writeUtf16(text: string): this {
    for (const char of text) {
      const unit = char.charCodeAt(0);
      this.write(unit & 0xff, 8).write(unit >> 8, 8);
    }
    return this;
  }

  public toBytes(): Uint8Array {
    const bytes = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, i) => {
      bytes[i >> 3] |= bit << (7 - (i & 7));
    });
    return bytes;
  }
}

describe("BitReader", () => {
  it("reads MSB-first across byte boundaries", () => {
    const reader = new BitReader(Uint8Array.from([0b10110011, 0b01010101]));
    assert.equal(reader.read(3), 0b101);
    assert.equal(reader.read(7), 0b1001101);
    assert.equal(reader.position, 10);
  });

  it("reads little-endian integers at unaligned offsets", () => {
    const bytes = new BitWriter()
      .write(0b101, 3)
      .writeLittleEndian(0x0009000312345678n, 8)
      .toBytes();
    assert.equal(
      new BitReader(bytes).peekLittleEndianBytes(3, 8),
      0x0009000312345678n,
    );
  });
});

describe("splitPackets", () => {
  it("parses headers and stops at ChunkEnd", () => {
    const header = (type: number, size: number, micros: bigint) => {
      const b = Buffer.alloc(16);
      b.writeUInt16LE(type, 0);
      b.writeUInt32LE(size, 4);
      b.writeBigUInt64LE(micros, 8);
      return b;
    };
    const inflated = Buffer.concat([
      header(PacketType.Frame, 3, 1000n),
      Buffer.from([1, 2, 3]),
      header(PacketType.ChunkEnd, 0, 2000n),
      Buffer.from([99]),
    ]);
    const packets = splitPackets(inflated);
    assert.deepEqual(
      packets.map((p) => [p.type, p.payload.length, p.timestampMicros]),
      [
        [PacketType.Frame, 3, 1000],
        [PacketType.ChunkEnd, 0, 2000],
      ],
    );
  });

  it("rejects truncated packets", () => {
    const b = Buffer.alloc(16);
    b.writeUInt32LE(50, 4);
    assert.throws(() => splitPackets(b));
  });
});

describe("parseRoster", () => {
  it("pairs a gamertag with its xuid and reads the player index", () => {
    const xuid = 0x0009000312345678n;
    const bytes = new BitWriter()
      .write(0, 7)
      .write(5, 5)
      .writeLittleEndian(xuid, 8)
      .write(0, 40)
      .write(0, 16)
      .writeUtf16("Spartan 117")
      .write(0, 16)
      .write(0, 152)
      .writeLittleEndian(xuid, 8)
      .write(0, 16)
      .toBytes();
    assert.deepEqual(parseRoster(bytes), [
      { playerIndex: 5, xuid: xuid.toString(), gamertag: "Spartan 117" },
    ]);
  });
});

describe("biped components", () => {
  it("decodes aim angles and shield after the position block", () => {
    // 2 tail bits, then i5: q=64 (full shield) + no regen + 16 + 4 pad bits
    // then i21: flag, yaw=1024 (90 deg), pitch=1024 (0 deg)
    const bits =
      "00" + "01000000" + "0" + "0".repeat(20) + "0" + "010000000000" + "10000000000";
    const bytes = new Uint8Array(Math.ceil(bits.length / 8));
    [...bits].forEach((b, i) => {
      if (b === "1") bytes[i >> 3] |= 0x80 >> (i & 7);
    });
    const out = readBipedComponents(new BitReader(bytes), 0, [0, 5, 21]);
    assert.equal(out.shieldQ, 64);
    assert.ok(Math.abs((out.shield ?? 0) - 1) < 0.02);
    assert.ok(Math.abs((out.aimYawDeg ?? 0) - yawDegrees(1024)) < 1e-9);
    assert.ok(Math.abs(pitchDegrees(1024)) < 0.1);
    assert.ok(Math.abs((out.aimPitchDeg ?? 99) - pitchDegrees(1024)) < 1e-9);
  });
});

const sampleDir = path.join(
  import.meta.dirname,
  "../../../packages/match-downloader/films/26d45816-3c2b-41ae-84b5-9e0cc1d1c096",
);

function sampleManifest() {
  return JSON.parse(readFileSync(path.join(sampleDir, "manifest.json"), "utf8"));
}

function sampleMetadata() {
  const { MatchId, FilmLength, FilmMajorVersion, HasGameEnded } =
    sampleManifest().CustomData;
  return {
    matchId: MatchId,
    filmLengthMs: FilmLength,
    majorVersion: FilmMajorVersion,
    hasGameEnded: HasGameEnded,
  };
}

function* sampleChunks(): Generator<FilmChunkInput> {
  for (const c of sampleManifest().CustomData.Chunks) {
    yield {
      index: c.Index,
      chunkType: c.ChunkType,
      startTimeOffsetMs: c.ChunkStartTimeOffsetMilliseconds,
      durationMs: c.DurationMilliseconds,
      data: readFileSync(
        path.join(sampleDir, c.FileRelativePath.replace(/^[\\/]/, "")),
      ),
    };
  }
}

describe("sample film", { skip: !existsSync(sampleDir) }, () => {
  it("parses roster, registry and frame timeline", async () => {
    const film = await parseFilm(sampleMetadata(), sampleChunks());
    assert.equal(film.chunks.length, 41);
    assert.deepEqual(
      film.players.map((p) => p.gamertag),
      [
        "iDankDank v3",
        "Connor 018",
        "GravlLift",
        "Miss Luvless",
        "iKaZu0",
        "Miighty Chew",
        "MuhammadAllbee",
        "BeetleCrisp",
        "MistrDuggy",
      ],
    );
    assert.ok(
      film.registry.components.some(
        (c) => c.name === "statborg-current-round-value-stat-component",
      ),
    );
    const frames = film.chunks.reduce((sum, c) => sum + c.frames.count, 0);
    assert.ok(frames > 40000);
    assert.equal(film.chunks[2].packetCounts.chunkEnd, 1);
  });
});

function track(slot: number, startMs: number, endMs: number) {
  const sample = (timeMs: number) => ({
    timeMs,
    q: [0, 0, 0] as [number, number, number],
    normalized: [0, 0, 0] as [number, number, number],
  });
  return { slot, samples: [sample(startMs), sample(endMs)] };
}

describe("linkLives", () => {
  it("hands each respawn to the player who died first", () => {
    const actors = linkLives([
      track(512, 0, 30_000),
      track(513, 0, 20_000),
      track(520, 30_000, 60_000), // 513 died first and respawns first
      track(521, 40_000, 70_000),
      track(900, 5_000, 6_000), // too short: noise
    ]);
    assert.equal(actors.length, 2);
    assert.deepEqual(
      actors.map((a) => a.lives.map((l) => l.slot)),
      [
        [512, 521],
        [513, 520],
      ],
    );
  });
});

describe("graves", () => {
  it("marks a death until the respawn, and ignores a survivor", () => {
    const tracks = [
      track(512, 0, 30_000), // dies at 30 s; respawns as 520
      track(520, 40_000, 100_000), // survives to the end
      track(513, 0, 100_000), // survives
    ];
    const positions = {
      tracks,
      actors: linkLives(tracks),
    } as unknown as Parameters<typeof createReplay>[0];
    const replay = createReplay(positions, undefined, undefined, [], [], [], {}, 100_000);
    assert.equal(replay.graves(20_000).length, 0);
    assert.equal(replay.graves(35_000).length, 1);
    assert.equal(replay.graves(45_000).length, 0);
    assert.equal(replay.graves(100_000).length, 0);
  });
});

describe("findBipedSlots", () => {
  it("keeps gapped slots near anchors and drops distant noise", () => {
    const counts = new Map([
      [512, 1000],
      [516, 600],
      [519, 40],
      [1700, 300],
    ]);
    assert.deepEqual(
      [...findBipedSlots(counts, 1000)].sort((a, b) => a - b),
      [512, 516],
    );
  });
});

describe("bindPlayers", () => {
  const track = (slot: number, start: number, end: number) => ({
    slot,
    samples: Array.from({ length: 10 }, (_, i) => ({
      timeMs: start + ((end - start) * i) / 9,
    })),
  });
  const death = (xuid: string, timeMs: number) => ({
    xuid,
    gamertag: `p${xuid}`,
    type: "death" as const,
    typeHint: 20,
    timeMs,
    isMedal: false,
    medalType: 1,
  });

  it("names lives by the death that ends them, with a constant clock offset", () => {
    const tracks = [
      track(1, 0, 10000),
      track(2, 0, 20000),
      track(3, 15000, 30000),
      track(4, 25000, 40000),
    ];
    // Event clock runs 500 ms behind the track clock.
    const events = [death("A", 9500), death("B", 19500), death("A", 29500)];
    const result = bindPlayers(tracks as never, events, [
      { xuid: "A", team: 1 },
    ]);
    assert.equal(result.clockOffsetMs, 500);
    assert.equal(result.matchedDeaths, 3);
    const a = result.actors.find((x) => x.xuid === "A");
    const b = result.actors.find((x) => x.xuid === "B");
    assert.deepEqual(a?.lives.map((l) => l.slot), [1, 3]);
    assert.equal(a?.team, 1);
    // The unnamed final life goes to B, who is dead when it starts.
    assert.deepEqual(b?.lives.map((l) => l.slot), [2, 4]);
  });
});
describe("buildScoreTimeline", () => {
  const record = (timeMs: number, slot: number, a: number): StatRecord => ({
    timeMs,
    slot,
    round: 0,
    comps: new Map([[0, { a, b: 0 }]]),
  });

  it("builds cumulative team series and resolves team ids from final scores", () => {
    const playerRecords: StatRecord[] = Array.from({ length: 30 }, (_, i) => ({
      timeMs: i,
      slot: 10,
      round: 0,
      comps: new Map([[2, { a: i, b: 0 }]]),
    }));
    const timeline = buildScoreTimeline(
      [
        ...playerRecords,
        record(1000, 8, 1),
        record(2000, 8, 2),
        record(1500, 8, 0),
        record(3000, 6, 1),
      ],
      [
        { team: 0, score: 1 },
        { team: 1, score: 2 },
      ],
    );
    const [slot6, slot8] = timeline.teams;
    assert.equal(slot6.team, 0);
    assert.equal(slot8.team, 1);
    assert.equal(scoreAt(slot8, 1500), 1);
    assert.equal(scoreAt(slot8, 2500), 2);
    assert.equal(scoreAt(slot6, 2500), 0);
    assert.equal(scoreAt(slot6, 3500), 1);
  });
});
