interface ZipFixtureEntry {
  path: string;
  bytes?: Uint8Array;
  unixMode?: number;
  compressionMethod?: number;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function write16(target: number[], value: number) {
  target.push(value & 0xff, (value >>> 8) & 0xff);
}

function write32(target: number[], value: number) {
  write16(target, value & 0xffff);
  write16(target, value >>> 16);
}

export function jsonBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function createStoredZip(entries: ZipFixtureEntry[]): Uint8Array {
  const output: number[] = [];
  const central: number[] = [];
  for (const entry of entries) {
    const path = new TextEncoder().encode(entry.path);
    const bytes = entry.bytes ?? new Uint8Array();
    const crc = crc32(bytes);
    const localOffset = output.length;
    write32(output, 0x04034b50);
    write16(output, 20);
    write16(output, 0x0800);
    write16(output, entry.compressionMethod ?? 0);
    write16(output, 0);
    write16(output, 0);
    write32(output, crc);
    write32(output, bytes.length);
    write32(output, bytes.length);
    write16(output, path.length);
    write16(output, 0);
    output.push(...path, ...bytes);

    write32(central, 0x02014b50);
    write16(central, entry.unixMode === undefined ? 20 : (3 << 8) | 20);
    write16(central, 20);
    write16(central, 0x0800);
    write16(central, entry.compressionMethod ?? 0);
    write16(central, 0);
    write16(central, 0);
    write32(central, crc);
    write32(central, bytes.length);
    write32(central, bytes.length);
    write16(central, path.length);
    write16(central, 0);
    write16(central, 0);
    write16(central, 0);
    write16(central, 0);
    write32(central, (entry.unixMode ?? 0) << 16);
    write32(central, localOffset);
    central.push(...path);
  }
  const centralOffset = output.length;
  output.push(...central);
  write32(output, 0x06054b50);
  write16(output, 0);
  write16(output, 0);
  write16(output, entries.length);
  write16(output, entries.length);
  write32(output, central.length);
  write32(output, centralOffset);
  write16(output, 0);
  return Uint8Array.from(output);
}

export const validMrpackManifest = {
  formatVersion: 1,
  game: "minecraft",
  versionId: "test-pack",
  dependencies: {
    minecraft: "1.21.1",
    "fabric-loader": "0.16.10",
  },
  xmcl: { javaMajor: 21, templateId: "fabric-1.21" },
  files: [{
    path: "mods/example.jar",
    provider: "modrinth",
    projectId: "project-a",
    fileId: "version-a",
    filename: "example.jar",
  }],
};

export const validCompatibility = {
  minecraftVersion: "1.21.1",
  loader: "fabric" as const,
  loaderVersion: "0.16.10",
  javaMajor: 21,
  templateId: "fabric-1.21",
};
