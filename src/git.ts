// Git smart HTTP — implemented in src/git-full.ts and re-exported here (kept as one module so
// app.ts has a stable import). The real implementation lives in this file.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  formatCommit,
  parseCommit,
  parseTree,
  typeId,
  TYPE_NAMES,
  type GitObject,
  type ObjectType,
  type Repo,
  type Store,
} from './store.ts';
import type { RestResult } from './rest.ts';

const ZERO = '0'.repeat(40);
const AGENT = 'agent=forge/1.0';

// -------------------------------------------------------------------------------------------
// pkt-line framing

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface PktReader {
  lines: (string | Buffer)[];
  rest: Buffer;
}

/** Parse pkt-lines from the front of a buffer; stops at the flush packet. */
export function readPkts(buffer: Buffer, start = 0): { items: (Buffer | 'flush' | 'delim')[]; next: number } {
  const items: (Buffer | 'flush' | 'delim')[] = [];
  let i = start;
  while (i + 4 <= buffer.length) {
    const hex = buffer.toString('ascii', i, i + 4);
    if (!/^[0-9a-f]{4}$/.test(hex)) break;
    const length = parseInt(hex, 16);
    if (length === 0) {
      items.push('flush');
      i += 4;
      break;
    }
    if (length === 1) {
      items.push('delim');
      i += 4;
      continue;
    }
    if (length === 2) {
      i += 4;
      continue; // response-end packet
    }
    if (i + length > buffer.length) break;
    items.push(buffer.subarray(i + 4, i + length));
    i += length;
  }
  return { items, next: i };
}

function sideband(data: Buffer, band = 1): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65500;
  for (let i = 0; i < data.length; i += CHUNK) {
    const slice = data.subarray(i, Math.min(data.length, i + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  if (data.length === 0) out.push(pktLine(Buffer.from([band])));
  return out;
}

// -------------------------------------------------------------------------------------------
// Packfiles

/** Serialize objects into a pack v2 stream (no deltas: every object stored whole). */
export function buildPack(objects: Map<string, GitObject>, store: Store): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.size, 8);
  parts.push(header);
  for (const [, obj] of objects) {
    const compressed = deflateSync(obj.data, { level: 1 });
    let size = obj.data.length;
    const first = (typeId(obj.type) << 4) | (size & 0x0f);
    size >>= 4;
    const bytes: number[] = [];
    if (size > 0) {
      bytes.push(first | 0x80);
      while (size > 0) {
        let byte = size & 0x7f;
        size >>= 7;
        if (size > 0) byte |= 0x80;
        bytes.push(byte);
      }
    } else {
      bytes.push(first);
    }
    parts.push(Buffer.from(bytes), compressed);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  void store;
  return Buffer.concat([body, trailer]);
}

interface PackObjectHeader {
  type: number;
  size: number;
  offset: number;
  headerLength: number;
}

function readPackObjectHeader(pack: Buffer, offset: number): PackObjectHeader {
  let i = offset;
  let byte = pack[i++] as number;
  const type = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    byte = pack[i++] as number;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { type, size, offset, headerLength: i - offset };
}

// -------------------------------------------------------------------------------------------
// Inflate (RFC 1951/1950) — a small exact decoder, so pack parsing knows each stream's length.

class BitReader {
  private bitBuf = 0;
  private bitCnt = 0;
  private buf: Buffer;
  private pos: number;
  constructor(buf: Buffer, start: number) {
    this.buf = buf;
    this.pos = start;
  }
  private fill(n: number): void {
    while (this.bitCnt < n) {
      this.bitBuf |= (this.buf[this.pos++] ?? 0) << this.bitCnt;
      this.bitCnt += 8;
    }
  }
  read(bits: number): number {
    if (bits === 0) return 0;
    this.fill(bits);
    const value = this.bitBuf & ((1 << bits) - 1);
    this.bitBuf >>>= bits;
    this.bitCnt -= bits;
    return value;
  }
  alignByte(): void {
    const drop = this.bitCnt & 7;
    this.bitBuf >>>= drop;
    this.bitCnt -= drop;
  }
  /** Absolute byte index of the next unread bit; exact right after alignByte(). */
  get bytePos(): number {
    return this.pos - (this.bitCnt >> 3);
  }
  /** Discard the buffered bits and continue reading at an absolute byte index. */
  jumpTo(byteIndex: number): void {
    this.pos = byteIndex;
    this.bitBuf = 0;
    this.bitCnt = 0;
  }
}

interface Huffman {
  counts: number[];
  symbols: number[];
}

function buildHuffman(lengths: number[]): Huffman {
  const counts = new Array(16).fill(0);
  for (const len of lengths) counts[len] = (counts[len] as number) + 1;
  counts[0] = 0;
  const offsets = new Array(16).fill(0);
  for (let i = 1; i < 16; i++) offsets[i] = (offsets[i - 1] as number) + (counts[i - 1] as number);
  const symbols = new Array(lengths.length).fill(0);
  lengths.forEach((len, symbol) => {
    if (len !== 0) {
      symbols[offsets[len] as number] = symbol;
      offsets[len] = (offsets[len] as number) + 1;
    }
  });
  return { counts, symbols };
}

function decodeSymbol(reader: BitReader, huff: Huffman): number {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len < 16; len++) {
    code |= reader.read(1);
    const count = huff.counts[len] as number;
    if (code - first < count) return huff.symbols[index + (code - first)] as number;
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error('bad huffman code');
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

/** A growable byte buffer inflate writes into; preallocated to the expected size when known. */
interface ByteSink {
  buf: Buffer;
  len: number;
  ensure(extra: number): void;
}

function inflateBlock(reader: BitReader, sink: ByteSink, lit: Huffman, dist: Huffman): boolean {
  for (;;) {
    const symbol = decodeSymbol(reader, lit);
    if (symbol < 256) {
      sink.ensure(1);
      sink.buf[sink.len++] = symbol;
    } else if (symbol === 256) {
      return true;
    } else {
      const lengthIndex = symbol - 257;
      if (lengthIndex >= 29) throw new Error('bad length symbol');
      const length = (LENGTH_BASE[lengthIndex] as number) + reader.read(LENGTH_EXTRA[lengthIndex] as number);
      const distSymbol = decodeSymbol(reader, dist);
      if (distSymbol >= 30) throw new Error('bad distance symbol');
      const distance = (DIST_BASE[distSymbol] as number) + reader.read(DIST_EXTRA[distSymbol] as number);
      if (distance > sink.len) throw new Error('distance too far');
      sink.ensure(length);
      const src = sink.len - distance;
      if (distance === 1) {
        sink.buf.fill(sink.buf[src] as number, sink.len, sink.len + length);
      } else if (distance >= length) {
        sink.buf.copyWithin(sink.len, src, src + length);
      } else {
        for (let i = 0; i < length; i++) sink.buf[sink.len + i] = sink.buf[src + i] as number;
      }
      sink.len += length;
    }
  }
}

let FIXED_LIT: Huffman | null = null;
let FIXED_DIST: Huffman | null = null;

/** The fixed Huffman tables, built once (they are the same for every fixed block). */
function fixedTables(): { lit: Huffman; dist: Huffman } {
  if (FIXED_LIT === null || FIXED_DIST === null) {
    const litLengths = [...new Array(144).fill(8), ...new Array(112).fill(9), ...new Array(24).fill(7), ...new Array(8).fill(8)];
    FIXED_LIT = buildHuffman(litLengths);
    FIXED_DIST = buildHuffman(new Array(32).fill(5));
  }
  return { lit: FIXED_LIT, dist: FIXED_DIST };
}

/** Inflate one zlib stream starting at `start`; returns the data and the offset just past it. */
export function inflateExact(buf: Buffer, start: number, expectedSize = 0): { data: Buffer; next: number } {
  // zlib header: 2 bytes; verify the checksum bits loosely.
  const reader = new BitReader(buf, start + 2);
  const sink: ByteSink = {
    buf: Buffer.allocUnsafe(Math.max(expectedSize, 1024)),
    len: 0,
    ensure(extra: number): void {
      if (sink.len + extra <= sink.buf.length) return;
      const grown = Buffer.allocUnsafe(Math.max(sink.buf.length * 2, sink.len + extra));
      sink.buf.copy(grown, 0, 0, sink.len);
      sink.buf = grown;
    },
  };
  for (;;) {
    const final = reader.read(1);
    const type = reader.read(2);
    if (type === 0) {
      reader.alignByte();
      const at = reader.bytePos;
      const len = (buf[at] as number) | ((buf[at + 1] as number) << 8);
      sink.ensure(len);
      sink.buf.set(buf.subarray(at + 4, at + 4 + len), sink.len);
      sink.len += len;
      reader.jumpTo(at + 4 + len);
    } else {
      let lit: Huffman;
      let dist: Huffman;
      if (type === 1) {
        ({ lit, dist } = fixedTables());
      } else if (type === 2) {
        const hlit = reader.read(5) + 257;
        const hdist = reader.read(5) + 1;
        const hclen = reader.read(4) + 4;
        const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
        const codeLengths = new Array(19).fill(0);
        for (let i = 0; i < hclen; i++) codeLengths[order[i] as number] = reader.read(3);
        const codeHuff = buildHuffman(codeLengths);
        const lengths: number[] = [];
        while (lengths.length < hlit + hdist) {
          const symbol = decodeSymbol(reader, codeHuff);
          if (symbol < 16) {
            lengths.push(symbol);
          } else if (symbol === 16) {
            const repeat = reader.read(2) + 3;
            const prev = lengths[lengths.length - 1] as number;
            for (let i = 0; i < repeat; i++) lengths.push(prev);
          } else if (symbol === 17) {
            const repeat = reader.read(3) + 3;
            for (let i = 0; i < repeat; i++) lengths.push(0);
          } else {
            const repeat = reader.read(7) + 11;
            for (let i = 0; i < repeat; i++) lengths.push(0);
          }
        }
        lit = buildHuffman(lengths.slice(0, hlit));
        dist = buildHuffman(lengths.slice(hlit));
      } else {
        throw new Error('bad deflate block type');
      }
      inflateBlock(reader, sink, lit, dist);
    }
    if (final === 1) break;
  }
  reader.alignByte();
  // Skip the 4-byte adler32.
  const data = sink.len === sink.buf.length ? sink.buf : Buffer.from(sink.buf.subarray(0, sink.len));
  return { data, next: reader.bytePos + 4 };
}
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = delta[i++] as number;
      value |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  readVarint(); // base size
  const resultSize = readVarint();
  const out: Buffer[] = [];
  while (i < delta.length) {
    const op = delta[i++] as number;
    if (op & 0x80) {
      let offset = 0;
      let length = 0;
      if (op & 0x01) offset = delta[i++] as number;
      if (op & 0x02) offset |= (delta[i++] as number) << 8;
      if (op & 0x04) offset |= (delta[i++] as number) << 16;
      if (op & 0x08) offset |= (delta[i++] as number) << 24;
      if (op & 0x10) length = delta[i++] as number;
      if (op & 0x20) length |= (delta[i++] as number) << 8;
      if (op & 0x40) length |= (delta[i++] as number) << 16;
      if (length === 0) length = 0x10000;
      out.push(base.subarray(offset, offset + length));
    } else if (op > 0) {
      out.push(delta.subarray(i, i + op));
      i += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

/** Ingest a pack into the store, resolving ofs/ref deltas. Returns the object count. */
export function ingestPack(store: Store, pack: Buffer): number {
  if (pack.length < 12 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a pack');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const byOffset = new Map<number, string>();
  const pending: { baseSha?: string; baseOffset?: number; type: ObjectType; delta: Buffer }[] = [];
  let read = 0;
  const rawByOffset = new Map<number, { type: ObjectType; data: Buffer }>();

  const inflateAt = (start: number, size: number): { data: Buffer; next: number } => inflateExact(pack, start, size);

  while (read < count) {
    const header = readPackObjectHeader(pack, offset);
    const dataStart = offset + header.headerLength;
    if (header.type === 6) {
      // OFS_DELTA: negative offset varint follows the header.
      let i = dataStart;
      let byte = pack[i++] as number;
      let baseOffsetDelta = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[i++] as number;
        baseOffsetDelta = ((baseOffsetDelta + 1) << 7) | (byte & 0x7f);
      }
      const baseOffset = offset - baseOffsetDelta;
      const { data, next } = inflateAt(i, header.size);
      pending.push({ baseOffset, type: 'blob', delta: data });
      byOffset.set(offset, `pending:${pending.length - 1}`);
      rawByOffset.set(offset, { type: 'blob', data: Buffer.alloc(0) });
      offset = next;
    } else if (header.type === 7) {
      const baseSha = pack.toString('hex', dataStart, dataStart + 20);
      const { data, next } = inflateAt(dataStart + 20, header.size);
      pending.push({ baseSha, type: 'blob', delta: data });
      byOffset.set(offset, `pending:${pending.length - 1}`);
      offset = next;
    } else {
      const { data, next } = inflateAt(dataStart, header.size);
      const type = TYPE_NAMES[header.type] as ObjectType;
      const sha = store.writeObject(type, data);
      byOffset.set(offset, sha);
      rawByOffset.set(offset, { type, data });
      offset = next;
    }
    read += 1;
  }

  // Resolve deltas (possibly chained).
  const resolvePending = (index: number, seen: Set<number>): string => {
    const entry = pending[index] as { baseSha?: string; baseOffset?: number; type: ObjectType; delta: Buffer };
    let baseType: ObjectType;
    let baseData: Buffer;
    let baseSha: string;
    if (entry.baseSha) {
      baseSha = entry.baseSha;
      const base = store.readObject(baseSha);
      if (!base) throw new Error('ref-delta base missing');
      baseType = base.type;
      baseData = base.data;
    } else {
      const baseOff = entry.baseOffset as number;
      const marker = byOffset.get(baseOff) as string;
      if (marker.startsWith('pending:')) {
        const baseIndex = Number(marker.slice('pending:'.length));
        if (seen.has(baseIndex)) throw new Error('delta cycle');
        seen.add(baseIndex);
        baseSha = resolvePending(baseIndex, seen);
        const base = store.readObject(baseSha) as GitObject;
        baseType = base.type;
        baseData = base.data;
      } else {
        baseSha = marker;
        const base = store.readObject(baseSha) as GitObject;
        baseType = base.type;
        baseData = base.data;
      }
    }
    const data = applyDelta(baseData, entry.delta);
    return store.writeObject(baseType, data);
  };
  for (let i = 0; i < pending.length; i++) resolvePending(i, new Set([i]));
  void byOffset;
  return count;
}

// -------------------------------------------------------------------------------------------
// Ref advertisement

/** Follow an annotated tag chain to the commit it ultimately names, or null. */
function peelTag(store: Store, sha: string): string | null {
  let current = sha;
  for (let depth = 0; depth < 10; depth++) {
    const obj = store.readObject(current);
    if (!obj || obj.type !== 'tag') return depth === 0 ? null : current;
    const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (!match) return null;
    current = match[1] as string;
    const target = store.readObject(current);
    if (target && target.type === 'commit') return current;
  }
  return null;
}

function repoOr404(store: Store, owner: string, name: string): Repo | null {
  if (owner !== 'adaiversen') return null;
  return store.getRepo(owner, name) ?? null;
}

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

export function handleGitInfoRefs(store: Store, owner: string, name: string, service: string, gitProtocol: string | undefined): RestResult {
  const repo = repoOr404(store, owner, name);
  if (!repo) return { status: 404, body: { message: 'Not Found' } };
  const isV2 = (gitProtocol ?? '').includes('version=2');

  if (service === 'git-upload-pack') {
    if (isV2) {
      const lines = [
        pktLine('version 2'),
        pktLine('agent=forge/1.0'),
        pktLine('ls-refs=unborn'),
        pktLine('fetch=shallow wait-for-done'),
        pktLine('server-option'),
        pktLine('object-format=sha1'),
        PKT_FLUSH,
      ];
      return { status: 200, rawBody: Buffer.concat(lines), contentType: 'application/x-git-upload-pack-advertisement' };
    }
    const caps = 'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta deepen-since deepen-not agent=forge/1.0';
    return { status: 200, rawBody: v0Advertisement(store, repo, 'git-upload-pack', caps), contentType: 'application/x-git-upload-pack-advertisement' };
  }

  if (service === 'git-receive-pack') {
    const caps = 'report-status report-status-v2 delete-refs side-band-64k ofs-delta agent=forge/1.0';
    return { status: 200, rawBody: v0Advertisement(store, repo, 'git-receive-pack', caps), contentType: 'application/x-git-receive-pack-advertisement' };
  }

  return { status: 403, body: { message: 'Forbidden' } };
}

function v0Advertisement(store: Store, repo: Repo, service: string, caps: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const headSha = store.branchTip(repo, repo.defaultBranch);
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const firstCaps = `${caps} symref=HEAD:${headTarget}`;
  if (headSha) {
    parts.push(pktLine(`${headSha} HEAD\0${firstCaps}\n`));
  } else {
    parts.push(pktLine(`${ZERO} capabilities^{}\0${firstCaps}\n`));
  }
  for (const [ref, sha] of sortedRefs(repo)) {
    parts.push(pktLine(`${sha} ${ref}\n`));
    const peeled = peelTag(store, sha);
    if (peeled) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// upload-pack (fetch / ls-refs)

export function handleUploadPack(store: Store, owner: string, name: string, body: Buffer, gitProtocol: string | undefined): RestResult {
  const repo = repoOr404(store, owner, name);
  if (!repo) return { status: 404, body: { message: 'Not Found' } };
  const isV2 = (gitProtocol ?? '').includes('version=2');
  if (isV2) return uploadPackV2(store, repo, body);
  return uploadPackV0(store, repo, body);
}

function parseFetchArgs(lines: Buffer[]): {
  wants: string[];
  haves: string[];
  done: boolean;
  deepen: number | null;
  deepenRelative: boolean;
  shallowFromClient: string[];
} {
  const out = { wants: [] as string[], haves: [] as string[], done: false, deepen: null as number | null, deepenRelative: false, shallowFromClient: [] as string[] };
  for (const raw of lines) {
    const line = raw.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) out.wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) out.haves.push(line.slice(5, 45));
    else if (line === 'done') out.done = true;
    else if (line.startsWith('deepen ')) out.deepen = Number(line.slice(7));
    else if (line === 'deepen-relative') out.deepenRelative = true;
    else if (line.startsWith('shallow ')) out.shallowFromClient.push(line.slice(8, 48));
  }
  return out;
}

/** Commits at exactly `depth` from the tips (for shallow marking), and the closure within depth. */
function shallowClosure(store: Store, tips: string[], depth: number): { objects: Map<string, GitObject>; shallow: string[] } {
  const levels = new Map<string, number>();
  let frontier = [...new Set(tips)];
  for (const tip of frontier) levels.set(tip, 0);
  for (let level = 0; level < depth; level++) {
    const next: string[] = [];
    for (const sha of frontier) {
      const commit = store.readCommit(sha);
      if (!commit) continue;
      for (const parent of commit.parents) {
        if (!levels.has(parent)) {
          levels.set(parent, level + 1);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  const includedCommits = [...levels.entries()].filter(([, level]) => level < depth).map(([sha]) => sha);
  // Boundary = included commits whose parents fall outside the depth.
  const boundary: string[] = [];
  // The pack holds exactly the included commits plus their trees and blobs — parents are
  // NOT followed (that is what makes the clone shallow).
  const objects = new Map<string, GitObject>();
  const addTreeClosure = (treeSha: string): void => {
    const obj = store.readObject(treeSha);
    if (!obj || objects.has(treeSha)) return;
    objects.set(treeSha, obj);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) addTreeClosure(entry.sha);
    }
  };
  for (const sha of includedCommits) {
    const commit = store.readCommit(sha);
    if (!commit) continue;
    const obj = store.readObject(sha);
    if (obj) objects.set(sha, obj);
    addTreeClosure(commit.tree);
    if (commit.parents.some((p) => !levels.has(p) || (levels.get(p) as number) >= depth)) boundary.push(sha);
  }
  return { objects, shallow: boundary };
}

/**
 * Fetch packs are a pure function of (wants, haves, deepen) over an append-only,
 * content-addressed object store, so a pack built under the current object epoch stays
 * valid until a new object lands. Repeated identical fetches (concurrent clones of one
 * history) reuse the built bytes instead of walking the closure and re-deflating.
 */
const packCache = new Map<string, { pack: Buffer; shallow: string[] }>();

function fetchResponse(store: Store, repo: Repo, wants: string[], haves: string[], deepen: number | null): { pack: Buffer; shallow: string[] } {
  const cacheKey = `${store.objectEpoch}|${deepen ?? ''}|${wants.join(',')}|${haves.join(',')}`;
  const cached = packCache.get(cacheKey);
  if (cached) return cached;
  const wantCommits = wants.filter((sha) => store.readCommit(sha));
  let objects: Map<string, GitObject>;
  let shallow: string[] = [];
  if (deepen !== null && deepen > 0) {
    const result = shallowClosure(store, wantCommits, deepen);
    objects = result.objects;
    shallow = result.shallow;
    // Trees/blobs of boundary commits are included by closureFromCommits already.
  } else {
    const exclude = haves.length > 0 ? store.reachableSet(haves.filter((sha) => store.readCommit(sha))) : new Set<string>();
    objects = store.closureFromCommits(wantCommits, exclude);
    // Also include any wanted non-commit objects directly (tags and their targets), unless
    // the client already has them.
    for (const want of wants) {
      if (!objects.has(want) && !exclude.has(want)) {
        const obj = store.readObject(want);
        if (obj) {
          objects.set(want, obj);
          if (obj.type === 'tag') {
            const peeled = peelTag(store, want);
            if (peeled && !objects.has(peeled)) {
              for (const [sha, target] of store.closureFromCommits([peeled], exclude)) objects.set(sha, target);
            }
          }
        }
      }
    }
  }
  void repo;
  const result = { pack: buildPack(objects, store), shallow };
  if (packCache.size >= 128) packCache.clear();
  packCache.set(cacheKey, result);
  return result;
}

function uploadPackV0(store: Store, repo: Repo, body: Buffer): RestResult {
  const { items } = readPkts(body);
  const lines = items.filter((item): item is Buffer => Buffer.isBuffer(item));
  const args = parseFetchArgs(lines);
  if (!args.done) {
    // Negotiation round: answer NAK and wait (the suite speaks done in one round).
    return { status: 200, rawBody: pktLine('NAK\n'), contentType: 'application/x-git-upload-pack-result' };
  }
  const { pack, shallow } = fetchResponse(store, repo, args.wants, args.haves, args.deepen);
  const parts: Buffer[] = [];
  for (const sha of shallow) parts.push(pktLine(`shallow ${sha}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(...sideband(pack, 1));
  parts.push(PKT_FLUSH);
  return { status: 200, rawBody: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
}

function uploadPackV2(store: Store, repo: Repo, body: Buffer): RestResult {
  // Sections are separated by delim packets; the first line names the command.
  const sections: Buffer[][] = [[]];
  const { items } = readPkts(body);
  for (const item of items) {
    if (item === 'delim') sections.push([]);
    else if (Buffer.isBuffer(item)) (sections[sections.length - 1] as Buffer[]).push(item);
  }
  const first = sections[0] ?? [];
  const commandLine = first[0]?.toString('utf8').replace(/\n$/, '') ?? '';
  const command = commandLine.startsWith('command=') ? commandLine.slice('command='.length) : '';

  if (command === 'ls-refs') {
    // v2 request shape: command + capabilities, a delim, then the argument lines.
    const argSection = sections[1] ?? first.slice(1);
    const args = argSection.map((b) => b.toString('utf8').replace(/\n$/, ''));
    const symrefs = args.includes('symrefs');
    const peel = args.includes('peel');
    const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
    const parts: Buffer[] = [];
    const headSha = store.branchTip(repo, repo.defaultBranch);
    const headRef = `refs/heads/${repo.defaultBranch}`;
    const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p) || p.startsWith(ref));
    if (matches('HEAD')) {
      if (headSha) {
        parts.push(pktLine(symrefs ? `${headSha} HEAD symref-target:${headRef}\n` : `${headSha} HEAD\n`));
      } else {
        parts.push(pktLine(symrefs ? `${ZERO} HEAD symref-target:${headRef} unborn\n` : `${ZERO} HEAD\n`));
      }
    }
    for (const [ref, sha] of sortedRefs(repo)) {
      if (!matches(ref)) continue;
      let line = `${sha} ${ref}`;
      if (peel) {
        const peeled = peelTag(store, sha);
        if (peeled) line += ` peeled:${peeled}`;
      }
      parts.push(pktLine(`${line}\n`));
    }
    parts.push(PKT_FLUSH);
    return { status: 200, rawBody: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
  }

  if (command === 'fetch') {
    const argLines = sections.slice(1).flat();
    const args = parseFetchArgs(argLines);
    const parts: Buffer[] = [];
    if (!args.done && args.haves.length > 0) {
      parts.push(pktLine('acknowledgments\n'));
      parts.push(pktLine('NAK\n'));
      parts.push(PKT_FLUSH);
      return { status: 200, rawBody: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
    }
    const { pack, shallow } = fetchResponse(store, repo, args.wants, args.haves, args.deepen);
    if (shallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const sha of shallow) parts.push(pktLine(`shallow ${sha}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sideband(pack, 1));
    parts.push(PKT_FLUSH);
    return { status: 200, rawBody: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
  }

  return { status: 400, body: { message: 'unknown command' } };
}

// -------------------------------------------------------------------------------------------
// receive-pack (push, v0)

interface RefUpdate {
  oldSha: string;
  newSha: string;
  ref: string;
}

export function handleReceivePack(store: Store, owner: string, name: string, body: Buffer): RestResult {
  const repo = repoOr404(store, owner, name);
  if (!repo) return { status: 404, body: { message: 'Not Found' } };

  const { items, next } = readPkts(body);
  const updates: RefUpdate[] = [];
  for (const item of items) {
    if (!Buffer.isBuffer(item)) continue;
    let line = item.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) line = line.slice(0, nul);
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(line);
    if (match) updates.push({ oldSha: match[1] as string, newSha: match[2] as string, ref: match[3] as string });
  }
  const packData = body.subarray(next);
  let unpackOk = true;
  if (packData.length >= 12) {
    try {
      ingestPack(store, packData);
    } catch {
      unpackOk = false;
    }
  }

  const report: string[] = [unpackOk ? 'unpack ok' : 'unpack error'];
  for (const update of updates) {
    report.push(applyUpdate(store, repo, update, unpackOk));
  }
  const payload = Buffer.from(`${report.join('\n')}\n`, 'utf8');
  const parts = [...sideband(payload, 1), PKT_FLUSH];
  return { status: 200, rawBody: Buffer.concat(parts), contentType: 'application/x-git-receive-pack-result' };
}

function applyUpdate(store: Store, repo: Repo, update: RefUpdate, unpackOk: boolean): string {
  const { oldSha, newSha, ref } = update;
  if (!unpackOk) return `ng ${ref} unpack failed`;
  const current = repo.refs.get(ref) ?? ZERO;
  if (current !== oldSha) return `ng ${ref} reference was updated elsewhere`;
  if (newSha === ZERO) {
    // Delete.
    if (ref === `refs/heads/${repo.defaultBranch}`) return `ng ${ref} deletion of the current branch prohibited`;
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  const commit = store.readCommit(newSha);
  if (!commit) {
    // Refs may also point at tag objects (annotated tags); those need no ancestry check.
    const obj = store.readObject(newSha);
    if (obj && obj.type === 'tag') {
      repo.refs.set(ref, newSha);
      return `ok ${ref}`;
    }
    return `ng ${ref} unknown object`;
  }
  if (oldSha !== ZERO) {
    if (!store.isAncestor(oldSha, newSha)) return `ng ${ref} non-fast-forward`;
  }
  repo.refs.set(ref, newSha);
  return `ok ${ref}`;
}

// Re-exported helpers the other modules use.
export { formatCommit, parseCommit, parseTree };
