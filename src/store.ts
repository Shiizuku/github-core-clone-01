// The forge's in-memory store: git objects, repositories, labels, issues, pull requests and
// comments. Everything lives in Maps; nothing touches disk. All timestamps come from a logical
// clock (a counter over a fixed epoch) so two runs that take the same requests produce the same
// SHAs and the same bytes.

import { createHash } from 'node:crypto';

export const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };

const EPOCH_MS = 1_700_000_000_000;
let clockSeq = 0;

/** The next deterministic timestamp, as a Date. */
export function tick(): Date {
  clockSeq += 1;
  return new Date(EPOCH_MS + clockSeq * 1000);
}

/** The next deterministic timestamp as git's "<unix> +0000". */
export function tickGit(): string {
  const d = tick();
  return `${Math.floor(d.getTime() / 1000)} +0000`;
}

// -------------------------------------------------------------------------------------------
// Git objects

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

const TYPE_IDS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const TYPE_NAMES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
export function typeId(type: ObjectType): number {
  return TYPE_IDS[type];
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export interface CommitData {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitData {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const out: CommitData = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

export function formatCommit(commit: CommitData): Buffer {
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${commit.author}`, `committer ${commit.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const mode = data.toString('utf8', i, sp);
    const nul = data.indexOf(0x00, sp + 1);
    const name = data.toString('utf8', sp + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    i = nul + 21;
  }
  return entries;
}

export function formatTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Git's tree sort key: directories sort as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
}

// -------------------------------------------------------------------------------------------
// Repositories and their records

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  id: number;
  body: string;
  userLogin: string;
  createdAt: Date;
}

export interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  createdAt: Date;
  updatedAt: Date;
  comments: CommentRec[];
  isPull: boolean;
}

export interface PullRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  userLogin: string;
  createdAt: Date;
  updatedAt: Date;
  merged: boolean;
  mergedAt: Date | null;
  mergeCommitSha: string | null;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: Date;
  updatedAt: Date;
  /** Full ref name ("refs/heads/main") to a commit sha. */
  refs: Map<string, string>;
  labels: Map<string, Label>;
  /** Issues and pull requests share one number sequence, as on GitHub. */
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
}

export class Store {
  objects = new Map<string, GitObject>();
  repos = new Map<string, Repo>();
  private repoSeq = 0;
  private commentSeq = 0;

  // ----- objects -----

  writeObject(type: ObjectType, data: Buffer): string {
    const sha = hashObject(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  readObject(sha: string): GitObject | undefined {
    return this.objects.get(sha);
  }

  writeBlob(content: Buffer): string {
    return this.writeObject('blob', content);
  }

  writeCommit(commit: CommitData): string {
    return this.writeObject('commit', formatCommit(commit));
  }

  readCommit(sha: string): CommitData | undefined {
    const obj = this.objects.get(sha);
    if (!obj || obj.type !== 'commit') return undefined;
    return parseCommit(obj.data);
  }

  /** Every object reachable from a commit: the commit, its trees and blobs, recursively. */
  closureFromCommits(tips: string[], exclude: Set<string>): Map<string, GitObject> {
    const out = new Map<string, GitObject>();
    const stack: string[] = [...tips];
    const seenCommits = new Set<string>();
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (exclude.has(sha) || out.has(sha) || seenCommits.has(sha)) continue;
      const obj = this.objects.get(sha);
      if (!obj) continue;
      if (obj.type === 'commit') {
        seenCommits.add(sha);
        out.set(sha, obj);
        const commit = parseCommit(obj.data);
        stack.push(commit.tree, ...commit.parents);
      } else if (obj.type === 'tree') {
        out.set(sha, obj);
        for (const entry of parseTree(obj.data)) stack.push(entry.sha);
      } else {
        out.set(sha, obj);
      }
    }
    return out;
  }

  /** All objects reachable from a set of "have" commits (for pack exclusion). */
  reachableSet(tips: string[]): Set<string> {
    return new Set(this.closureFromCommits(tips, new Set()).keys());
  }

  /** Is `ancestor` reachable from `descendant` through commit parents? */
  isAncestor(ancestor: string, descendant: string): boolean {
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (sha === ancestor) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const commit = this.readCommit(sha);
      if (commit) stack.push(...commit.parents);
    }
    return false;
  }

  /** Flatten a commit's tree into path -> {mode, sha}. */
  flattenTree(commitSha: string): Map<string, { mode: string; sha: string }> {
    const out = new Map<string, { mode: string; sha: string }>();
    const commit = this.readCommit(commitSha);
    if (!commit) return out;
    const walk = (treeSha: string, prefix: string): void => {
      const obj = this.objects.get(treeSha);
      if (!obj || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '40000') walk(entry.sha, `${prefix}${entry.name}/`);
        else out.set(`${prefix}${entry.name}`, { mode: entry.mode, sha: entry.sha });
      }
    };
    walk(commit.tree, '');
    return out;
  }

  /** Build nested tree objects from a flat path -> {mode, sha} map; returns the root tree sha. */
  buildTree(files: Map<string, { mode: string; sha: string }>): string {
    interface Node {
      dirs: Map<string, Node>;
      files: TreeEntry[];
    }
    const root: Node = { dirs: new Map(), files: [] };
    for (const [path, file] of files) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i] as string;
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
        node = node.dirs.get(part) as Node;
      }
      node.files.push({ mode: file.mode, name: parts[parts.length - 1] as string, sha: file.sha });
    }
    const emit = (node: Node): string => {
      const entries: TreeEntry[] = [...node.files];
      for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, sha: emit(dir) });
      return this.writeObject('tree', formatTree(sortTreeEntries(entries)));
    };
    return emit(root);
  }

  /** The merge base of two commits (nearest common ancestor; first found by BFS from b). */
  mergeBase(a: string, b: string): string | null {
    const ancestorsOfA = new Set<string>();
    const stackA = [a];
    while (stackA.length > 0) {
      const sha = stackA.pop() as string;
      if (ancestorsOfA.has(sha)) continue;
      ancestorsOfA.add(sha);
      const commit = this.readCommit(sha);
      if (commit) stackA.push(...commit.parents);
    }
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const sha = queue.shift() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      if (ancestorsOfA.has(sha)) return sha;
      const commit = this.readCommit(sha);
      if (commit) queue.push(...commit.parents);
    }
    return null;
  }

  // ----- repositories -----

  repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    this.repoSeq += 1;
    const now = tick();
    const repo: Repo = {
      id: this.repoSeq,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.id - b.id);
  }

  /** Resolve a ref name, short branch name or sha to a commit sha. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (/^[0-9a-f]{40}$/.test(ref) && this.readCommit(ref)) return ref;
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    return repo.refs.get(full) ?? repo.refs.get(ref);
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }
}

/** A forge-wide commit identity for commits the API itself creates. */
export function apiIdentity(): string {
  return `${VIEWER.name} <${VIEWER.email}> ${tickGit()}`;
}
