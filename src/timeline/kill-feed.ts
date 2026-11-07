import type { DamageEvent } from '../decoders/damage-events';
import type { HighlightEvent } from '../decoders/highlight-events';
import type { LinkedFilmPositions } from '../decoders/positions';

export interface KillFeedPlayer {
  xuid: string;
  gamertag?: string;
  team?: number;
}

export interface KillFeedDamageDealer extends KillFeedPlayer {
  damagePercent: number;
}

export interface KillFeedEntry {
  timeMs: number;
  killer?: KillFeedPlayer;
  killerDamagePercent?: number;
  victim?: KillFeedPlayer;
  damageAssists: KillFeedDamageDealer[];
}

export function buildKillFeed(
  events: readonly HighlightEvent[],
  positions: Pick<LinkedFilmPositions, 'actors' | 'highlightClockOffsetMs'>,
  damageEvents: readonly DamageEvent[],
): KillFeedEntry[] {
  const kills = events.filter((event) => event.type === 'kill');
  const deaths = events.filter((event) => event.type === 'death');
  const candidates = kills
    .flatMap((kill, killIndex) =>
      deaths.flatMap((death, deathIndex) => {
        const gap = Math.abs(kill.timeMs - death.timeMs);
        return gap <= 5 && kill.xuid !== death.xuid
          ? [{ killIndex, deathIndex, gap }]
          : [];
      }),
    )
    .sort(
      (a, b) =>
        a.gap - b.gap ||
        a.killIndex - b.killIndex ||
        a.deathIndex - b.deathIndex,
    );
  const paired = new Map<number, number>();
  const usedDeaths = new Set<number>();
  for (const candidate of candidates) {
    if (paired.has(candidate.killIndex) || usedDeaths.has(candidate.deathIndex))
      continue;
    paired.set(candidate.killIndex, candidate.deathIndex);
    usedDeaths.add(candidate.deathIndex);
  }
  const player = (event: HighlightEvent): KillFeedPlayer => {
    const actor = positions.actors.find((entry) => entry.xuid === event.xuid);
    return {
      xuid: event.xuid,
      gamertag: event.gamertag || actor?.gamertag,
      team: actor?.team,
    };
  };
  const offset = positions.highlightClockOffsetMs ?? 0;
  const entry = (
    kill?: HighlightEvent,
    death?: HighlightEvent,
  ): KillFeedEntry => {
    const timeMs = (death ?? kill)?.timeMs ?? 0;
    const replayTime = timeMs + offset;
    const killer = kill && player(kill);
    const victim = death && player(death);
    const victimActor = positions.actors.find(
      (actor) => actor.xuid === victim?.xuid,
    );
    const life = victimActor?.lives
      .filter(
        (item) =>
          item.startMs <= replayTime &&
          item.endMs >= replayTime - 1500 &&
          item.endMs <= replayTime + 3000,
      )
      .sort(
        (a, b) =>
          Math.abs(a.endMs - replayTime) - Math.abs(b.endMs - replayTime),
      )[0];
    const damageByPlayer = new Map<
      string,
      { player: KillFeedPlayer; magnitude: number }
    >();
    if (life && killer) {
      for (const damage of damageEvents) {
        if (
          damage.victimSlot !== life.slot ||
          damage.magnitude <= 0 ||
          damage.timeMs < life.startMs ||
          damage.timeMs > replayTime ||
          damage.attackerSlot === undefined
        )
          continue;
        const actor = positions.actors.find(
          (candidate) =>
            candidate.xuid &&
            candidate.lives.some(
              (attackerLife) =>
                attackerLife.slot === damage.attackerSlot &&
                damage.timeMs >= attackerLife.startMs - 500 &&
                damage.timeMs <= attackerLife.endMs + 500,
            ),
        );
        if (
          !actor?.xuid ||
          actor.xuid === victim?.xuid ||
          (actor.xuid !== killer.xuid &&
            killer.team !== undefined &&
            actor.team !== killer.team)
        )
          continue;
        const gamertag =
          actor.gamertag ||
          events.find((event) => event.xuid === actor.xuid && event.gamertag)
            ?.gamertag;
        const previous = damageByPlayer.get(actor.xuid);
        damageByPlayer.set(actor.xuid, {
          player: { xuid: actor.xuid, gamertag, team: actor.team },
          magnitude: (previous?.magnitude ?? 0) + damage.magnitude,
        });
      }
    }
    const total = [...damageByPlayer.values()].reduce(
      (sum, dealer) => sum + dealer.magnitude,
      0,
    );
    const percent = (magnitude: number) =>
      Math.round((magnitude / total) * 100);
    const killerDamage = killer && damageByPlayer.get(killer.xuid);
    return {
      timeMs: replayTime,
      killer,
      killerDamagePercent: killerDamage
        ? percent(killerDamage.magnitude)
        : undefined,
      victim,
      damageAssists: [...damageByPlayer.values()]
        .filter((dealer) => dealer.player.xuid !== killer?.xuid)
        .map((dealer) => ({
          ...dealer.player,
          damagePercent: percent(dealer.magnitude),
        })),
    };
  };
  return [
    ...kills.map((kill, index) =>
      entry(
        kill,
        paired.has(index) ? deaths[paired.get(index) ?? -1] : undefined,
      ),
    ),
    ...deaths
      .filter((_, index) => !usedDeaths.has(index))
      .map((death) => entry(undefined, death)),
  ].sort((a, b) => a.timeMs - b.timeMs);
}
