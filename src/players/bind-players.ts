import type { HighlightEvent } from '../decoders/highlight-events';
import type { BipedCreation } from '../decoders/biped-creations';
import type { Actor, Life } from './link-lives';
import type { SlotTrack } from '../decoders/positions';

/** A body is created before it first moves; slack for the creation frame landing just after. */
const CREATION_SLACK_MS = 500;

/** A life ends within this long of the death event that names its player. */
const DEATH_MATCH_WINDOW_MS = 250;
const OFFSET_SEARCH_MS = 5000;
const OFFSET_STEP_MS = 20;
/** A track may end this long before its death (it stops sampling early). */
const EARLY_END_MS = 1500;
/** A track may run this long past its death (a lingering body). */
const LATE_END_MS = 3000;
/** A life may start this long before / after death + respawn delay. */
const EARLY_START_MS = 1000;
const LATE_START_MS = 4000;
/** Respawn delay used when the film shows no clear one. */
const DEFAULT_RESPAWN_MS = 10_100;
const RESPAWN_SEARCH_MS = [1000, 20_000] as const;
const RESPAWN_BIN_MS = 50;
/** Cost per ms of error: death times are exact, respawn times jitter. */
const END_COST_PER_MS = 1 / 50;
const START_COST_PER_MS = 1 / 500;
const START_COST_CAP = 40;
/** Cost of leaving a death-bounded life without a track; above any feasible fit. */
const UNASSIGNED_COST = 1000;
const INFEASIBLE_COST = 1e9;

export interface PlayerIdentity {
  xuid: string;
  gamertag?: string;
  team?: number;
}

export interface BipedOwners {
  creations: readonly BipedCreation[];
  /** Participant index of each player, as listed in the film. */
  roster: readonly { playerIndex: number; xuid: string }[];
}

export interface BindResult {
  actors: Actor[];
  /** Added to a highlight-event time to get the position-track clock. */
  clockOffsetMs: number;
  /** Deaths that ended a known life, out of all deaths in the film. */
  matchedDeaths: number;
  totalDeaths: number;
  /** Lives named by the owner their body was created with. */
  ownedLives: number;
  totalLives: number;
}

/**
 * Names biped lives. Each body's creation record carries the participant index
 * of its owner, so a life is named by reading it. Lives without a readable
 * creation fall back to the death feed: a player's deaths fix their whole
 * timeline (the life after death k ends at death k+1 and starts one respawn
 * delay after death k) and tracks are assigned to those lives all at once, by
 * minimum total error. Whatever is left goes to the player who died most recently.
 */
export function bindPlayers(
  tracks: readonly SlotTrack[],
  events: readonly HighlightEvent[],
  players: readonly PlayerIdentity[] = [],
  owners?: BipedOwners,
): BindResult {
  const deaths = events.filter((e) => e.type === 'death');
  const lives = lifeSpans(tracks);
  const ends = lives.map((l) => l.endMs);
  const owner = ownersFromCreations(lives, owners);
  const ownedLives = owner.size;

  let clockOffsetMs = 0;
  let bestHits = -1;
  let bestGap = Infinity;
  for (
    let off = -OFFSET_SEARCH_MS;
    off <= OFFSET_SEARCH_MS;
    off += OFFSET_STEP_MS
  ) {
    let hits = 0;
    let gapSum = 0;
    for (const d of deaths) {
      const t = d.timeMs + off;
      let nearest = Infinity;
      for (const e of ends) nearest = Math.min(nearest, Math.abs(e - t));
      if (nearest < DEATH_MATCH_WINDOW_MS) {
        hits++;
        gapSum += nearest;
      }
    }
    // Among equal hit counts, prefer the offset where the matches are tightest.
    if (hits > bestHits || (hits === bestHits && gapSum < bestGap)) {
      bestHits = hits;
      bestGap = gapSum;
      clockOffsetMs = off;
    }
  }
  const deathTimes = new Map<string, number[]>();
  for (const d of [...deaths].sort((a, b) => a.timeMs - b.timeMs)) {
    const list = deathTimes.get(d.xuid) ?? [];
    list.push(d.timeMs + clockOffsetMs);
    deathTimes.set(d.xuid, list);
  }
  const respawnMs = estimateRespawnMs(lives, [...deathTimes.values()].flat());

  const open = lives.filter((l) => !owner.has(l));
  const ownedByXuid = new Map<string, Life[]>();
  for (const [life, xuid] of owner) {
    ownedByXuid.set(xuid, [...(ownedByXuid.get(xuid) ?? []), life]);
  }

  // One slot per life a player must have had: ends at death k+1, starts after death k.
  // A slot an already-named life of that player fits is accounted for.
  const slots: { xuid: string; endT?: number; startT?: number }[] = [];
  for (const [xuid, times] of deathTimes) {
    for (let k = 0; k <= times.length; k++) {
      const slot = {
        xuid,
        endT: times[k],
        startT: k > 0 ? times[k - 1] + respawnMs : undefined,
      };
      const named = (ownedByXuid.get(xuid) ?? []).some(
        (life) => fitCost(life, slot.endT, slot.startT) < UNASSIGNED_COST,
      );
      if (!named) slots.push(slot);
    }
  }
  const cost = slots.map((slot) =>
    open.map((life) => fitCost(life, slot.endT, slot.startT)),
  );
  const chosen = assignMinCost(cost);

  let matchedDeaths = 0;
  chosen.forEach((col, row) => {
    const slot = slots[row];
    if (col === undefined || cost[row][col] >= UNASSIGNED_COST) return;
    owner.set(open[col], slot.xuid);
    if (slot.endT !== undefined) matchedDeaths++;
  });

  const gamertags = new Map<string, string>();
  for (const e of events) if (e.gamertag) gamertags.set(e.xuid, e.gamertag);
  for (const p of players) if (p.gamertag) gamertags.set(p.xuid, p.gamertag);
  const teams = new Map(players.map((p) => [p.xuid, p.team]));

  const byXuid = new Map<string, Life[]>();
  for (const [life, xuid] of owner) {
    byXuid.set(xuid, [...(byXuid.get(xuid) ?? []), life]);
  }
  const overlaps = (a: Life, b: Life) =>
    a.startMs < b.endMs && b.startMs < a.endMs;
  for (const life of lives) {
    if (owner.has(life)) continue;
    let best: { xuid: string; gap: number } | undefined;
    for (const [xuid, own] of byXuid) {
      if (own.some((o) => overlaps(o, life))) continue;
      const before = own.filter((o) => o.endMs <= life.startMs);
      const gap = before.length
        ? life.startMs - Math.max(...before.map((o) => o.endMs))
        : Infinity;
      if (!best || gap < best.gap) best = { xuid, gap };
    }
    if (best) {
      owner.set(life, best.xuid);
      byXuid.get(best.xuid)?.push(life);
    }
  }

  const actors: Actor[] = [...byXuid.entries()].map(([xuid, own], actor) => ({
    actor,
    xuid,
    gamertag: gamertags.get(xuid) ?? xuid,
    team: teams.get(xuid),
    lives: own.sort((a, b) => a.startMs - b.startMs),
  }));
  return {
    actors,
    clockOffsetMs,
    matchedDeaths,
    totalDeaths: deaths.length,
    ownedLives,
    totalLives: lives.length,
  };
}

/** A life is owned by the participant its body was created with. */
function ownersFromCreations(
  lives: readonly Life[],
  owners: BipedOwners | undefined,
): Map<Life, string> {
  const owner = new Map<Life, string>();
  if (!owners) return owner;
  const xuidOf = new Map(owners.roster.map((p) => [p.playerIndex, p.xuid]));
  for (const life of lives) {
    // A slot can be reused; the creation that counts is the latest before the life began.
    const creation = owners.creations
      .filter(
        (c) =>
          c.slot === life.slot && c.timeMs <= life.startMs + CREATION_SLACK_MS,
      )
      .reduce<
        BipedCreation | undefined
      >((latest, c) => (!latest || c.timeMs > latest.timeMs ? c : latest), undefined);
    const xuid = creation && xuidOf.get(creation.participantIndex);
    if (xuid) owner.set(life, xuid);
  }
  return owner;
}

/** The respawn delay is the most common gap between a death and a life starting. */
function estimateRespawnMs(
  lives: readonly Life[],
  deathTimes: number[],
): number {
  const [min, max] = RESPAWN_SEARCH_MS;
  const bins = new Map<number, number>();
  for (const t of deathTimes) {
    for (const life of lives) {
      const gap = life.startMs - t;
      if (gap < min || gap > max) continue;
      const bin = Math.floor(gap / RESPAWN_BIN_MS);
      bins.set(bin, (bins.get(bin) ?? 0) + 1);
    }
  }
  let best: { bin: number; count: number } | undefined;
  for (const [bin, count] of bins) {
    const near = count + (bins.get(bin - 1) ?? 0) + (bins.get(bin + 1) ?? 0);
    if (!best || near > best.count) best = { bin, count: near };
  }
  return best ? (best.bin + 0.5) * RESPAWN_BIN_MS : DEFAULT_RESPAWN_MS;
}

/** How badly a life fits a slot that ends at `endT` and/or starts at `startT`. */
function fitCost(life: Life, endT?: number, startT?: number): number {
  let cost = 0;
  if (endT !== undefined) {
    const err = life.endMs - endT;
    if (err < -EARLY_END_MS || err > LATE_END_MS) return INFEASIBLE_COST;
    cost += Math.abs(err) * END_COST_PER_MS;
  }
  if (startT !== undefined) {
    const err = life.startMs - startT;
    const outside = err < -EARLY_START_MS || err > LATE_START_MS;
    // Respawn delay shortens near a round's end, so a known end outweighs a late start.
    if (outside && endT === undefined) return INFEASIBLE_COST;
    cost += Math.min(Math.abs(err) * START_COST_PER_MS, START_COST_CAP);
  }
  return cost;
}

/**
 * Minimum-cost assignment of rows to distinct columns (Hungarian algorithm).
 * A row may stay unassigned at `UNASSIGNED_COST`; it then maps to undefined.
 */
function assignMinCost(
  cost: readonly (readonly number[])[],
): (number | undefined)[] {
  const n = cost.length;
  const realCols = n === 0 ? 0 : cost[0].length;
  const m = realCols + n;
  const at = (i: number, j: number) =>
    j < realCols ? cost[i][j] : UNASSIGNED_COST;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const matchedRow = new Array<number>(m + 1).fill(0);
  const way = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    matchedRow[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(Infinity);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = matchedRow[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = at(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[matchedRow[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (matchedRow[j0] !== 0);
    do {
      const j1 = way[j0];
      matchedRow[j0] = matchedRow[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  const result = new Array<number | undefined>(n).fill(undefined);
  for (let j = 1; j <= realCols; j++) {
    if (matchedRow[j] !== 0) result[matchedRow[j] - 1] = j - 1;
  }
  return result;
}

function lifeSpans(tracks: readonly SlotTrack[]): Life[] {
  return tracks
    .filter((t) => t.samples.length > 1)
    .map((t) => ({
      slot: t.slot,
      startMs: t.samples[0].timeMs,
      endMs: t.samples[t.samples.length - 1].timeMs,
      sampleCount: t.samples.length,
    }))
    .filter((l) => l.endMs - l.startMs >= 1000);
}
