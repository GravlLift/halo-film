export interface ComponentRegistry {
  /** First u32 of the chunk; purpose unknown. */
  header: number;
  /** Unique component names with the number of slots they occupy. */
  components: { name: string; kind: number; slots: number }[];
  slotCount: number;
}

const SLOT_SIZE = 260;
const SLOT_START = 4;
const NAME_OFFSET = 4;

/**
 * Chunk 0 (ChunkType 1) is a pure name table of the ECS components that the
 * replication data refers to: slots of `[kind u32 LE][ASCII name, null padded
 * to 256 bytes]`.
 */
export function parseRegistry(inflated: Uint8Array): ComponentRegistry {
  const view = new DataView(
    inflated.buffer,
    inflated.byteOffset,
    inflated.byteLength,
  );
  const latin1 = new TextDecoder("latin1");
  const byName = new Map<
    string,
    { name: string; kind: number; slots: number }
  >();
  let slotCount = 0;
  for (
    let offset = SLOT_START;
    offset + SLOT_SIZE <= inflated.length;
    offset += SLOT_SIZE
  ) {
    const nameStart = offset + NAME_OFFSET;
    let nameEnd = inflated.indexOf(0, nameStart);
    if (nameEnd < 0 || nameEnd > offset + SLOT_SIZE) {
      nameEnd = offset + SLOT_SIZE;
    }
    if (nameEnd === nameStart) continue;
    const name = latin1.decode(inflated.subarray(nameStart, nameEnd));
    // Empty slots and the unrelated binary data after the table are skipped.
    if (!/^[A-Za-z][A-Za-z0-9_-]{2,}$/.test(name)) continue;
    slotCount++;
    const existing = byName.get(name);
    if (existing) existing.slots++;
    else
      byName.set(name, {
        name,
        kind: view.getUint32(offset, true),
        slots: 1,
      });
  }
  return {
    header: inflated.length >= 4 ? view.getUint32(0, true) : 0,
    components: [...byName.values()],
    slotCount,
  };
}
