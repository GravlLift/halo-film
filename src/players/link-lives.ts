import type { SlotTrack } from "../decoders/positions";

export interface Life {
  slot: number;
  startMs: number;
  endMs: number;
  sampleCount: number;
}

export interface Actor {
  /** Anonymous, stable id for one player across respawns (0-based). */
  actor: number;
  /** Set when the actor was bound to a real player. */
  xuid?: string;
  gamertag?: string;
  team?: number;
  lives: Life[];
}

// Shorter fragments are post-match noise; real lives last at least ~6 s.
const MIN_LIFE_MS = 4000;

/**
 * Every respawn allocates a new biped slot, and the film carries no
 * slot-to-player binding. Respawn delay is constant, so the player that died
 * first is the one that respawns first: each new life is given to the actor
 * whose previous life ended earliest.
 */
export function linkLives(tracks: readonly SlotTrack[]): Actor[] {
  const lives: Life[] = tracks
    .filter(
      (t) =>
        t.samples[t.samples.length - 1].timeMs - t.samples[0].timeMs >=
        MIN_LIFE_MS,
    )
    .map((t) => ({
      slot: t.slot,
      startMs: t.samples[0].timeMs,
      endMs: t.samples[t.samples.length - 1].timeMs,
      sampleCount: t.samples.length,
    }))
    .sort((a, b) => a.startMs - b.startMs || a.slot - b.slot);

  const actors: Actor[] = [];
  for (const life of lives) {
    const candidates = actors.filter(
      (a) => a.lives[a.lives.length - 1].endMs <= life.startMs,
    );
    candidates.sort(
      (a, b) => a.lives[a.lives.length - 1].endMs - b.lives[b.lives.length - 1].endMs,
    );
    const owner = candidates[0];
    if (owner) {
      owner.lives.push(life);
    } else {
      actors.push({ actor: actors.length, lives: [life] });
    }
  }
  return actors;
}
