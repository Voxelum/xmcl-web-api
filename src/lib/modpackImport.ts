export interface ModpackZipLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalUncompressedBytes: number;
  maxCompressionRatio: number;
}

export const DEFAULT_MODPACK_ZIP_LIMITS: Readonly<ModpackZipLimits> = {
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntries: 4096,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 100,
};

export type ZipRejectionCode =
  | "archive_too_large"
  | "bad_zip"
  | "encrypted_entry"
  | "unsupported_compression"
  | "too_many_entries"
  | "entry_too_large"
  | "total_size_exceeded"
  | "compression_ratio_exceeded"
  | "absolute_path"
  | "path_traversal"
  | "invalid_path"
  | "duplicate_path"
  | "symlink"
  | "crc_mismatch";

export class ModpackZipError extends Error {
  constructor(
    readonly code: ZipRejectionCode,
    readonly path?: string,
  ) {
    super(path ? `${code}: ${path}` : code);
    this.name = "ModpackZipError";
  }
}

export interface ModpackZipEntry {
  path: string;
  compressedSize: number;
  uncompressedSize: number;
  bytes: Uint8Array;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function uint16(view: DataView, offset: number) {
  return view.getUint16(offset, true);
}

function uint32(view: DataView, offset: number) {
  return view.getUint32(offset, true);
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const start = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
    if (
      bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 && bytes[offset + 3] === 0x06
    ) return offset;
  }
  throw new ModpackZipError("bad_zip");
}

function validatePath(rawPath: string): string {
  if (
    !rawPath || rawPath.includes("\0") || rawPath.includes("\\") ||
    rawPath.startsWith("/") || /^[a-zA-Z]:/.test(rawPath)
  ) {
    throw new ModpackZipError(
      rawPath.startsWith("/") || /^[a-zA-Z]:/.test(rawPath)
        ? "absolute_path"
        : "invalid_path",
      rawPath,
    );
  }
  const segments = rawPath.split("/");
  if (segments.some((part) => part === "..")) {
    throw new ModpackZipError("path_traversal", rawPath);
  }
  if (
    segments.some((part, index) =>
      (!part && index !== segments.length - 1) || part === "." ||
      /[<>:"|?*]/.test(part) ||
      [...part].some((character) => character.charCodeAt(0) <= 0x1f)
    )
  ) {
    throw new ModpackZipError("invalid_path", rawPath);
  }
  return rawPath.normalize("NFC");
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    const stream = new Blob([Uint8Array.from(bytes)]).stream().pipeThrough(
      new DecompressionStream("deflate-raw"),
    );
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new ModpackZipError("bad_zip");
  }
}

let crcTable: Uint32Array | undefined;
function crc32(bytes: Uint8Array): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    return crc >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export async function readModpackZip(
  archive: Uint8Array,
  limits: ModpackZipLimits = DEFAULT_MODPACK_ZIP_LIMITS,
): Promise<ModpackZipEntry[]> {
  if (archive.byteLength > limits.maxArchiveBytes) {
    throw new ModpackZipError("archive_too_large");
  }
  if (archive.byteLength < 22) throw new ModpackZipError("bad_zip");
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );
  const eocd = findEndOfCentralDirectory(archive);
  const disk = uint16(view, eocd + 4);
  const centralDisk = uint16(view, eocd + 6);
  const entriesOnDisk = uint16(view, eocd + 8);
  const entryCount = uint16(view, eocd + 10);
  const centralSize = uint32(view, eocd + 12);
  const centralOffset = uint32(view, eocd + 16);
  const commentLength = uint16(view, eocd + 20);
  if (
    disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    eocd + 22 + commentLength !== archive.length ||
    centralOffset + centralSize > eocd
  ) {
    throw new ModpackZipError("bad_zip");
  }
  if (entryCount > limits.maxEntries) {
    throw new ModpackZipError("too_many_entries");
  }

  const entries: ModpackZipEntry[] = [];
  const seen = new Set<string>();
  let totalSize = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > archive.length || uint32(view, cursor) !== 0x02014b50) {
      throw new ModpackZipError("bad_zip");
    }
    const madeBy = uint16(view, cursor + 4);
    const flags = uint16(view, cursor + 8);
    const method = uint16(view, cursor + 10);
    const expectedCrc = uint32(view, cursor + 16);
    const compressedSize = uint32(view, cursor + 20);
    const uncompressedSize = uint32(view, cursor + 24);
    const nameLength = uint16(view, cursor + 28);
    const extraLength = uint16(view, cursor + 30);
    const fileCommentLength = uint16(view, cursor + 32);
    const externalAttributes = uint32(view, cursor + 38);
    const localOffset = uint32(view, cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + fileCommentLength;
    if (
      end > archive.length || compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff || localOffset === 0xffffffff
    ) throw new ModpackZipError("bad_zip");

    let rawPath: string;
    try {
      rawPath = decoder.decode(
        archive.subarray(cursor + 46, cursor + 46 + nameLength),
      );
    } catch {
      throw new ModpackZipError("invalid_path");
    }
    const path = validatePath(rawPath);
    const duplicateKey = path.normalize("NFKC").toLocaleLowerCase("en-US");
    if (seen.has(duplicateKey)) {
      throw new ModpackZipError("duplicate_path", path);
    }
    seen.add(duplicateKey);

    const unixMode = externalAttributes >>> 16;
    if ((madeBy >>> 8) === 3 && (unixMode & 0o170000) === 0o120000) {
      throw new ModpackZipError("symlink", path);
    }
    if ((flags & 1) !== 0) throw new ModpackZipError("encrypted_entry", path);
    if (method !== 0 && method !== 8) {
      throw new ModpackZipError("unsupported_compression", path);
    }
    if (uncompressedSize > limits.maxEntryBytes) {
      throw new ModpackZipError("entry_too_large", path);
    }
    totalSize += uncompressedSize;
    if (totalSize > limits.maxTotalUncompressedBytes) {
      throw new ModpackZipError("total_size_exceeded");
    }
    if (
      uncompressedSize > 0 &&
      (compressedSize === 0 ||
        uncompressedSize / compressedSize > limits.maxCompressionRatio)
    ) {
      throw new ModpackZipError("compression_ratio_exceeded", path);
    }
    if (
      localOffset + 30 > centralOffset ||
      uint32(view, localOffset) !== 0x04034b50
    ) {
      throw new ModpackZipError("bad_zip", path);
    }
    const localFlags = uint16(view, localOffset + 6);
    const localMethod = uint16(view, localOffset + 8);
    const localNameLength = uint16(view, localOffset + 26);
    const localExtraLength = uint16(view, localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    let localPath: string;
    try {
      localPath = decoder.decode(
        archive.subarray(localOffset + 30, localOffset + 30 + localNameLength),
      ).normalize("NFC");
    } catch {
      throw new ModpackZipError("bad_zip", path);
    }
    if (
      localPath !== path || localFlags !== flags || localMethod !== method ||
      dataOffset + compressedSize > centralOffset
    ) {
      throw new ModpackZipError("bad_zip", path);
    }
    const compressed = archive.subarray(
      dataOffset,
      dataOffset + compressedSize,
    );
    const bytes = method === 0
      ? compressed.slice()
      : await inflateRaw(compressed);
    if (bytes.length !== uncompressedSize) {
      throw new ModpackZipError("bad_zip", path);
    }
    if (crc32(bytes) !== expectedCrc) {
      throw new ModpackZipError("crc_mismatch", path);
    }
    if (!path.endsWith("/")) {
      entries.push({ path, compressedSize, uncompressedSize, bytes });
    }
    cursor = end;
  }
  if (cursor !== centralOffset + centralSize) {
    throw new ModpackZipError("bad_zip");
  }
  return entries;
}
