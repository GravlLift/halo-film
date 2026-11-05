/**
 * Weapon families seen in keyframe loadouts, keyed by the high 32 bits of the
 * 64-bit weapon id. Ids and names come from LevelUp's filmshell catalogue.
 */
const FAMILIES: [string, string][] = [
  ['2b1824d5', 'BR75'],
  ['230447b1', 'Cindershot'],
  ['b619d84a', 'CQS48 Bulldog'],
  ['84bd29ed', 'Disruptor'],
  ['9d6aaed2', 'Fuel Rod SPNKr'],
  ['841ac5e5', 'Gravity Hammer'],
  ['2ac9c2ff', 'Heatwave'],
  ['71ab0a2c', 'M41 SPNKr'],
  ['2fb21c87', 'M392 Bandit'],
  ['6acdc44d', 'Bandit Evo'],
  ['48c19d2d', 'MA40 AR'],
  ['f5c335df', 'MA5K Avenger'],
  ['80977ba5', 'Mangler'],
  ['767db96d', 'MLRS-2 Hydra'],
  ['f408190f', 'Mk51 Sidekick'],
  ['d7915565', 'Mutilator'],
  ['b7262ca1', 'Mythic Sandwich'],
  ['b533957e', 'Needler'],
  ['c3542946', 'Plasma Pistol'],
  ['30484ea6', 'Pulse Carbine'],
  ['c30d87c7', 'Ravager'],
  ['0a1992bc', 'S7 Sniper'],
  ['880fe0bc', 'Sandwich'],
  ['a0955e9e', 'Sentinel Beam'],
  ['9387a8b9', 'Shock Rifle'],
  ['1a22fee6', 'Shock Rifle'],
  ['0d20c469', 'Skewer'],
  ['daf193c7', 'Stalker Rifle'],
  ['3e070217', 'Vestige Carbine'],
  ['fd98554c', 'VK78 Commando'],
  ['4ff3937e', 'Energy Sword'],
  ['0c55765f', 'Energy Sword'],
  ['b6dbead8', 'Frag Grenade'],
  ['c1e1bab0', 'Plasma Grenade'],
  ['3ad55da4', 'Dynamo Grenade'],
];

export const WEAPON_FAMILY_NAMES: ReadonlyMap<number, string> = new Map(
  FAMILIES.map(([hex, name]) => [parseInt(hex, 16), name]),
);

export const GRENADE_NAMES = ['Frag', 'Plasma', 'Dynamo', 'Spike'] as const;

const GRENADE_FAMILY_NAMES = new Set([
  'Frag Grenade',
  'Plasma Grenade',
  'Dynamo Grenade',
]);

export function isGrenadeFamily(family: number): boolean {
  const name = WEAPON_FAMILY_NAMES.get(family);
  return name !== undefined && GRENADE_FAMILY_NAMES.has(name);
}

/** Armor ability names by keyframe rank; only ranks whose name is unambiguous. */
const ABILITY_NAMES = new Map<number, string>([
  [19, 'Drop Wall'],
  [20, 'Grappleshot'],
  [21, 'Thruster'],
  [22, 'Threat Sensor'],
  [23, 'Repair Field'],
]);

export function abilityName(rank: number): string {
  return ABILITY_NAMES.get(rank) ?? `Equipment #${rank}`;
}
