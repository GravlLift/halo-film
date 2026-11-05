import type { SlotTrack } from '../decoders/positions';

/** Consecutive track starts closer than this belong to the same wave. */
const WAVE_GAP_MS = 2000;
/** A staging track is short-lived: observed 4-9 s. */
const MAX_STAGING_MS = 10000;
/** A wave this large of short tracks cannot be players dying and respawning. */
const MIN_WAVE_TRACKS = 6;

/**
 * At round and match ends the game spawns a burst of short-lived bipeds
 * outside the arena. Respawns are staggered, so many short tracks starting
 * together are not real lives. Returns the tracks without those bursts.
 */
export function dropStagingTracks(tracks: readonly SlotTrack[]): SlotTrack[] {
  const sorted = tracks
    .filter((t) => t.samples.length > 0)
    .sort((a, b) => a.samples[0].timeMs - b.samples[0].timeMs);
  const duration = (t: SlotTrack) =>
    t.samples[t.samples.length - 1].timeMs - t.samples[0].timeMs;

  const kept: SlotTrack[] = [];
  let wave: SlotTrack[] = [];
  const flush = () => {
    if (wave.length < MIN_WAVE_TRACKS) kept.push(...wave);
    wave = [];
  };
  for (const track of sorted) {
    const last = wave[wave.length - 1];
    if (
      duration(track) > MAX_STAGING_MS ||
      (last && track.samples[0].timeMs - last.samples[0].timeMs > WAVE_GAP_MS)
    ) {
      flush();
    }
    if (duration(track) > MAX_STAGING_MS) {
      kept.push(track);
    } else {
      wave.push(track);
    }
  }
  flush();
  return kept.sort((a, b) => a.slot - b.slot);
}
