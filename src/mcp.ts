// The MCP endpoint: JSON-RPC 2.0 over streamable HTTP. It speaks the 2026-07-28 revision
// (server/discover) and the classic initialize handshake, and its tools act on the same store
// as REST and GraphQL, so an object created here reads back identically over /api/v3.

import { tick, VIEWER, type IssueRec, type Repo, type Store } from './store.ts';
import { issueJson, performMerge, pullJson, repoJson } from './rest.ts';
import type { RestResult } from './rest.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
const SERVER_INFO = { name: 'forge-mcp', title: 'Forge MCP Server', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  required: string[];
  properties: Record<string, { type: string; description: string }>;
  run: (store: Store, args: Record<string, unknown>) => unknown;
}

function ownerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      owner = owner || (parts[0] as string);
      repo = repo || (parts[1] as string);
    }
  }
  return { owner, repo };
}

function findRepo(store: Store, args: Record<string, unknown>): Repo {
  const { owner, repo } = ownerRepo(args);
  const found = owner === VIEWER.login ? store.getRepo(owner, repo) : undefined;
  if (!found) throw new Error(`repository ${owner}/${repo} not found`);
  return found;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    run: (store, args) => {
      const name = String(args.name);
      if (store.getRepo(VIEWER.login, name)) throw new Error('name already exists on this account');
      const repo = store.createRepo(VIEWER.login, name, typeof args.description === 'string' ? args.description : '', args.private === true);
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get one repository by owner and name.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The owner/name pair, as an alternative.' },
    },
    run: (store, args) => repoJson(findRepo(store, args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The owner/name pair, as an alternative.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    run: (store, args) => {
      const repo = findRepo(store, args);
      const now = tick();
      const issue: IssueRec = {
        number: repo.nextNumber++,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        userLogin: VIEWER.login,
        createdAt: now,
        updatedAt: now,
        comments: [],
        isPull: false,
      };
      repo.issues.set(issue.number, issue);
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The owner/name pair, as an alternative.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    run: (store, args) => {
      const repo = findRepo(store, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()].filter((issue) => !issue.isPull);
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => b.number - a.number);
      return list.map((issue) => issueJson(repo, issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    required: ['owner', 'repo', 'title', 'head', 'base'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The owner/name pair, as an alternative.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    run: (store, args) => {
      const repo = findRepo(store, args);
      const head = String(args.head).includes(':') ? (String(args.head).split(':').pop() as string) : String(args.head);
      const base = String(args.base).includes(':') ? (String(args.base).split(':').pop() as string) : String(args.base);
      if (!store.branchTip(repo, head)) throw new Error(`head branch ${head} does not exist`);
      if (!store.branchTip(repo, base)) throw new Error(`base branch ${base} does not exist`);
      const now = tick();
      const number = repo.nextNumber++;
      const pull = {
        number,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        headRef: head,
        baseRef: base,
        userLogin: VIEWER.login,
        createdAt: now,
        updatedAt: now,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
      };
      repo.pulls.set(number, pull);
      repo.issues.set(number, {
        number,
        title: pull.title,
        body: pull.body,
        state: 'open',
        labels: [],
        userLogin: VIEWER.login,
        createdAt: now,
        updatedAt: now,
        comments: [],
        isPull: true,
      });
      return pullJson(store, repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request, by default with a squash commit.',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The owner/name pair, as an alternative.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
      merge_method: { type: 'string', description: 'merge, squash or rebase.' },
    },
    run: (store, args) => {
      const repo = findRepo(store, args);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) throw new Error(`pull request ${String(args.pull_number)} not found`);
      const method = typeof args.merge_method === 'string' ? args.merge_method : 'squash';
      const outcome = performMerge(store, repo, pull, method === 'merge' ? 'merge' : 'squash', {});
      if (!outcome.ok) throw new Error(outcome.message);
      return { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged', pull_request: pullJson(store, repo, pull) };
    },
  },
];

const TOOLS_LIST = TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: {
    type: 'object',
    properties: tool.properties,
    required: tool.required,
    additionalProperties: true,
  },
}));

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function handleOne(store: Store, request: Record<string, unknown>): Record<string, unknown> | null {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  const isNotification = id === undefined;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS_LIST });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((t) => t.name === name) ?? TOOLS.find((t) => name.toLowerCase().endsWith(t.name.toLowerCase()));
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      for (const required of tool.required) {
        const value = args[required];
        if (value === undefined || value === null || value === '') {
          // owner/repo may arrive as full_name instead.
          if ((required === 'owner' || required === 'repo') && typeof args.full_name === 'string') continue;
          return rpcResult(id, { content: [{ type: 'text', text: `missing required argument: ${required}` }], isError: true });
        }
      }
      try {
        const output = tool.run(store, args);
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output, isError: false });
      } catch (err) {
        return rpcResult(id, { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true });
      }
    }
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function handleMcp(store: Store, method: string, raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<RestResult> {
  void headers;
  if (method === 'GET' || method === 'DELETE') {
    return { status: 405, body: rpcError(null, -32601, 'Method not allowed') };
  }
  if (method !== 'POST') return { status: 405, body: rpcError(null, -32601, 'Method not allowed') };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (Array.isArray(parsed)) {
    const responses = parsed
      .map((entry) => (typeof entry === 'object' && entry !== null ? handleOne(store, entry as Record<string, unknown>) : rpcError(null, -32600, 'Invalid request')))
      .filter((entry) => entry !== null);
    if (responses.length === 0) return { status: 202, body: {} };
    return { status: 200, body: responses };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid request') };
  }
  const response = handleOne(store, parsed as Record<string, unknown>);
  if (response === null) return { status: 202, body: {} };
  return { status: 200, body: response };
}
