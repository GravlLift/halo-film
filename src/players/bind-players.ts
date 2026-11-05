import type { HighlightEvent } from '../decoders/highlight-events';
import type { Actor, Life } from './link-lives';
import type { SlotTrack } from '../decoders/positions';

/** A life ends within this long of the death event that names its player. */
const DEATH_MATCH_WINDOW_MS = 250;
/** Looser fit allowed when re-seating a life's owner to resolve a trade. */
const SWAP_WINDOW_MS = 1500;
const OFFSET_SEARCH_MS = 5000;
/** A track may run this long past its death before it counts as a different life. */
const LATE_END_MS = 3000;
/** Lives ending this close together count as ending at the same instant (a frame is ~17 ms). */
const TIE_MS = 20;
const OFFSET_STEP_MS = 20;

export interface PlayerIdentity {
  xuid: string;
  gamertag?: string;
  team?: number;
}

export interface BindResult {
  actors: Actor[];
  /** Added to a highlight-event time to get the position-track clock. */
  clockOffsetMs: number;
  /** Deaths that ended a known life, out of all deaths in the film. */
  matchedDeaths: number;
  totalDeaths: number;
}

/**
 * Names biped lives from the highlight-event death feed: each death carries the
 * victim's xuid and a timestamp, and a life ends at its death. Lives that end
 * without a death (survivors, final lives) are given to the player that is not
 * alive at that time and respawned most recently before it.
 */
export function bindPlayers(
  tracks: readonly SlotTrack[],
  events: readonly HighlightEvent[],
  players: readonly PlayerIdentity[] = [],
): BindResult {
  const deaths = events.filter((e) => e.type === 'death');
  const lives = lifeSpans(tracks);
  const ends = lives.map((l) => l.endMs);

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
  const owner = new Map<Life, string>();
  const taken = new Set<Life>();
  const previousEnd = new Map<string, number>();
  const ownedDeath = new Map<HighlightEvent, Life>();
  let matchedDeaths = 0;
  // Simultaneous deaths (trades) tie on time, so a player's lives must also chain:
  // a life cannot start before the player's previous one ended, and among equally
  // timed candidates the one that starts soonest after it is the respawn.
  const ordered = [...deaths].sort((a, b) => a.timeMs - b.timeMs);
  for (const d of ordered) {
    const t = d.timeMs + clockOffsetMs;
    const floor = previousEnd.get(d.xuid) ?? -Infinity;
    const candidates = lives
      .filter((life) => !taken.has(life) && life.startMs >= floor)
      .map((life) => ({ life, gap: Math.abs(life.endMs - t) }))
      .filter((c) => c.gap < DEATH_MATCH_WINDOW_MS);
    if (candidates.length === 0) continue;
    const nearest = Math.min(...candidates.map((c) => c.gap));
    const best = candidates
      .filter((c) => c.gap <= nearest + TIE_MS)
      .sort((a, b) => a.life.startMs - b.life.startMs || a.gap - b.gap)[0].life;
    owner.set(best, d.xuid);
    taken.add(best);
    ownedDeath.set(d, best);
    previousEnd.set(d.xuid, best.endMs);
    matchedDeaths++;
  }

  // A trade can leave a death unmatched because the other player's death took its
  // life first. A player's lives never overlap, so try handing that life's current
  // owner a different, slightly looser fit and give the life to the unmatched death.
  const ownedBy = (xuid: string) => [...owner].filter(([, x]) => x === xuid);
  const overlapsOwned = (xuid: string, life: Life, except?: Life) =>
    ownedBy(xuid).some(
      ([o]) => o !== except && life.startMs < o.endMs && o.startMs < life.endMs,
    );
  const unmatched = ordered.filter((d) => !ownedDeath.has(d));
  for (const d of unmatched) {
    const t = d.timeMs + clockOffsetMs;
    for (const life of lives) {
      if (Math.abs(life.endMs - t) >= DEATH_MATCH_WINDOW_MS) continue;
      const holder = owner.get(life);
      if (!holder || holder === d.xuid) continue;
      if (overlapsOwned(d.xuid, life)) continue;
      const holderDeath = ordered.find((o) => ownedDeath.get(o) === life);
      if (!holderDeath) continue;
      const ht = holderDeath.timeMs + clockOffsetMs;
      const alt = lives
        .filter(
          (l) =>
            l !== life &&
            !owner.has(l) &&
            Math.abs(l.endMs - ht) < SWAP_WINDOW_MS &&
            !overlapsOwned(holder, l, life),
        )
        .sort((a, b) => Math.abs(a.endMs - ht) - Math.abs(b.endMs - ht))[0];
      if (!alt) continue;
      owner.set(alt, holder);
      ownedDeath.set(holderDeath, alt);
      owner.set(life, d.xuid);
      ownedDeath.set(d, life);
      taken.add(alt);
      matchedDeaths++;
      break;
    }
  }

  // Some tracks outlive their death (a lingering body), which the tight window
  // rejects. A death still unmatched claims an unowned life that was alive at that
  // moment and ends shortly after it.
  for (const d of ordered.filter((o) => !ownedDeath.has(o))) {
    const t = d.timeMs + clockOffsetMs;
    const best = lives
      .filter(
        (life) =>
          !owner.has(life) &&
          life.startMs < t &&
          life.endMs >= t - DEATH_MATCH_WINDOW_MS &&
          life.endMs - t < LATE_END_MS &&
          !overlapsOwned(d.xuid, life),
      )
      .sort((a, b) => a.endMs - t - (b.endMs - t))[0];
    if (!best) continue;
    owner.set(best, d.xuid);
    ownedDeath.set(d, best);
    taken.add(best);
    matchedDeaths++;
  }

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
  return { actors, clockOffsetMs, matchedDeaths, totalDeaths: deaths.length };
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
