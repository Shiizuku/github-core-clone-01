// The REST v3 surface: repositories, branches, commits, contents, labels, issues, comments and
// pull requests, answered the way api.github.com answers them, over the in-memory store.

import { apiIdentity, parseTree, tick, VIEWER, type IssueRec, type PullRec, type Repo, type Store } from './store.ts';

export interface RestResult {
  status: number;
  body?: unknown;
  rawBody?: Buffer;
  contentType?: string;
  headers?: Record<string, string>;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const notFound = (): RestResult => json(404, { message: 'Not Found' });
const unprocessable = (message: string): RestResult => json(422, { message, errors: [] });

// -------------------------------------------------------------------------------------------
// Object shapes

export function userJson(login: string): Record<string, unknown> {
  const isViewer = login === VIEWER.login;
  return {
    login,
    id: isViewer ? VIEWER.id : 1002,
    node_id: `U_${login}`,
    type: 'User',
    site_admin: false,
    name: isViewer ? VIEWER.name : login,
    email: isViewer ? VIEWER.email : `${login}@example.invalid`,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: fullName,
    private: repo.isPrivate,
    owner: userJson(repo.owner),
    description: repo.description,
    fork: false,
    html_url: `https://forge.invalid/${fullName}`,
    url: `/api/v3/repos/${fullName}`,
    clone_url: `https://forge.invalid/${fullName}.git`,
    git_url: `git://forge.invalid/${fullName}.git`,
    ssh_url: `git@forge.invalid:${fullName}.git`,
    created_at: repo.createdAt.toISOString(),
    updated_at: repo.updatedAt.toISOString(),
    pushed_at: repo.updatedAt.toISOString(),
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    language: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    license: null,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: repo.id * 1000 + [...repo.labels.keys()].indexOf(name) + 1,
    node_id: `L_${repo.id}_${name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? '',
    default: false,
  };
}

export function issueJson(repo: Repo, issue: IssueRec): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: repo.id * 1_000_000 + issue.number,
    node_id: `I_${repo.id}_${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(issue.userLogin),
    comments: issue.comments.length,
    created_at: issue.createdAt.toISOString(),
    updated_at: issue.updatedAt.toISOString(),
    closed_at: issue.state === 'closed' ? issue.updatedAt.toISOString() : null,
    author_association: 'OWNER',
    active_lock_reason: null,
  };
  if (issue.isPull) {
    base.pull_request = {
      url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${issue.number}`,
      html_url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${issue.number}`,
    };
  }
  return base;
}

function commentJson(repo: Repo, issue: IssueRec, commentId: number): Record<string, unknown> {
  const comment = issue.comments.find((c) => c.id === commentId) as IssueRec['comments'][number];
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    body: comment.body,
    user: userJson(comment.userLogin),
    created_at: comment.createdAt.toISOString(),
    updated_at: comment.createdAt.toISOString(),
    author_association: 'OWNER',
  };
}

function refObjectJson(store: Store, repo: Repo, branch: string): Record<string, unknown> {
  const sha = store.branchTip(repo, branch) ?? '';
  return {
    label: `${repo.owner}:${branch}`,
    ref: branch,
    sha,
    user: userJson(repo.owner),
    repo: repoJson(repo),
  };
}

export function pullJson(store: Store, repo: Repo, pull: PullRec): Record<string, unknown> {
  const issue = repo.issues.get(pull.number);
  const mergeable = computeMergeable(store, repo, pull);
  return {
    id: repo.id * 1_000_000 + pull.number,
    node_id: `PR_${repo.id}_${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(pull.userLogin),
    labels: (issue?.labels ?? []).map((name) => labelJson(repo, name)),
    created_at: pull.createdAt.toISOString(),
    updated_at: pull.updatedAt.toISOString(),
    closed_at: pull.state === 'closed' ? pull.updatedAt.toISOString() : null,
    merged_at: pull.mergedAt?.toISOString() ?? null,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    milestone: null,
    draft: false,
    head: refObjectJson(store, repo, pull.headRef),
    base: refObjectJson(store, repo, pull.baseRef),
    author_association: 'OWNER',
    merged: pull.merged,
    mergeable,
    mergeable_state: pull.merged ? 'clean' : mergeable === false ? 'dirty' : 'clean',
    merged_by: pull.merged ? userJson(pull.userLogin) : null,
    comments: issue?.comments.length ?? 0,
    review_comments: 0,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function commitJson(store: Store, sha: string): Record<string, unknown> | null {
  const commit = store.readCommit(sha);
  if (!commit) return null;
  const parseIdent = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
    if (!match) return { name: line, email: '', date: new Date(0).toISOString() };
    return { name: match[1] as string, email: match[2] as string, date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      author: parseIdent(commit.author),
      committer: parseIdent(commit.committer),
      message: commit.message,
      tree: { sha: commit.tree, url: '' },
      url: '',
      comment_count: 0,
    },
    url: '',
    html_url: '',
    comments_url: '',
    author: userJson(VIEWER.login),
    committer: userJson(VIEWER.login),
    parents: commit.parents.map((parent) => ({ sha: parent, url: '', html_url: '' })),
  };
}

// -------------------------------------------------------------------------------------------
// Merge machinery (file-level three-way merge)

interface MergeOutcome {
  conflict: boolean;
  files: Map<string, { mode: string; sha: string }>;
}

/** Three-way merge of flat file maps; a path changed differently on both sides conflicts. */
export function threeWayMerge(
  base: Map<string, { mode: string; sha: string }>,
  ours: Map<string, { mode: string; sha: string }>,
  theirs: Map<string, { mode: string; sha: string }>,
): MergeOutcome {
  const files = new Map(ours);
  const paths = new Set([...base.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const inBase = base.get(path);
    const inOurs = ours.get(path);
    const inTheirs = theirs.get(path);
    const oursChanged = inOurs?.sha !== inBase?.sha || inOurs?.mode !== inBase?.mode;
    const theirsChanged = inTheirs?.sha !== inBase?.sha || inTheirs?.mode !== inBase?.mode;
    if (!theirsChanged) continue;
    if (!oursChanged) {
      if (inTheirs) files.set(path, inTheirs);
      else files.delete(path);
      continue;
    }
    if (inOurs?.sha === inTheirs?.sha && inOurs?.mode === inTheirs?.mode) continue;
    return { conflict: true, files };
  }
  return { conflict: false, files };
}

export function pullTrees(store: Store, repo: Repo, pull: PullRec): { base: Map<string, { mode: string; sha: string }>; ours: Map<string, { mode: string; sha: string }>; theirs: Map<string, { mode: string; sha: string }> } | null {  const headTip = store.branchTip(repo, pull.headRef);
  const baseTip = store.branchTip(repo, pull.baseRef);
  if (!headTip || !baseTip) return null;
  const mergeBase = store.mergeBase(baseTip, headTip) ?? baseTip;
  return {
    base: store.flattenTree(mergeBase),
    ours: store.flattenTree(baseTip),
    theirs: store.flattenTree(headTip),
  };
}

export function computeMergeable(store: Store, repo: Repo, pull: PullRec): boolean | null {
  if (pull.state !== 'open') return null;
  const trees = pullTrees(store, repo, pull);
  if (!trees) return null;
  return !threeWayMerge(trees.base, trees.ours, trees.theirs).conflict;
}

/** Line-diff counts between two texts (small inputs; a plain LCS table is fine). */
export function diffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length > 2000 || b.length > 2000) {
    return { additions: b.length, deletions: a.length };
  }
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j] as number;
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j] as number, dp[j - 1] as number);
      prev = tmp;
    }
  }
  const common = dp[b.length] as number;
  return { additions: b.length - common, deletions: a.length - common };
}

// -------------------------------------------------------------------------------------------
// Contents commits

/** Apply file changes on a branch and commit them; returns the new commit sha. */
export function commitFiles(
  store: Store,
  repo: Repo,
  branch: string,
  changes: Map<string, { mode: string; sha: string } | null>,
  message: string,
): string {
  const tip = store.branchTip(repo, branch);
  const files = tip ? store.flattenTree(tip) : new Map<string, { mode: string; sha: string }>();
  for (const [path, change] of changes) {
    if (change === null) files.delete(path);
    else files.set(path, change);
  }
  const tree = store.buildTree(files);
  const identity = apiIdentity();
  const sha = store.writeCommit({
    tree,
    parents: tip ? [tip] : [],
    author: identity,
    committer: identity,
    message,
  });
  repo.refs.set(`refs/heads/${branch}`, sha);
  repo.updatedAt = tick();
  return sha;
}

// -------------------------------------------------------------------------------------------
// Routing

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, URL-decoded. */
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown>;
  baseUrl: string;
}

function bodyString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; perPage: number; pageNum: number } {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? 30) || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? 1) || 1);
  return { page: items.slice((pageNum - 1) * perPage, pageNum * perPage), perPage, pageNum };
}

function linkHeader(baseUrl: string, path: string, query: URLSearchParams, total: number, perPage: number, pageNum: number): string | undefined {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (pageNum >= lastPage) return undefined;
  const params = new URLSearchParams(query);
  params.set('per_page', String(perPage));
  params.set('page', String(pageNum + 1));
  const next = `<${baseUrl}${path}?${params.toString()}>; rel="next"`;
  params.set('page', String(lastPage));
  const last = `<${baseUrl}${path}?${params.toString()}>; rel="last"`;
  return `${next}, ${last}`;
}

export function handleRest(store: Store, req: RestRequest): RestResult {
  const { method, segments, query, body } = req;
  const seg = (i: number): string => segments[i] ?? '';

  // API root and meta.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return json(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      rate_limit_url: '/api/v3/rate_limit',
    });
  }
  if (seg(0) === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: false, github_connect: { origin: '' } });
  }
  if (seg(0) === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return json(200, userJson(VIEWER.login));
  }

  // The viewer's repository list and creation.
  if (seg(0) === 'user' && seg(1) === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const all = store.listRepos(VIEWER.login).map(repoJson);
      const { page, perPage, pageNum } = paginate(all, query);
      const link = linkHeader(req.baseUrl, '/api/v3/user/repos', query, all.length, perPage, pageNum);
      return json(200, page, link ? { Link: link } : undefined);
    }
    if (method === 'POST') {
      const name = bodyString(body, 'name');
      if (!name) return unprocessable('name is required');
      if (store.getRepo(VIEWER.login, name)) return unprocessable('name already exists on this account');
      const repo = store.createRepo(VIEWER.login, name, bodyString(body, 'description') ?? '', body.private === true);
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      return json(201, repoJson(repo));
    }
    return notFound();
  }

  if (seg(0) !== 'repos' || segments.length < 3) return notFound();
  const owner = seg(1);
  const repoName = seg(2);
  const repo = owner === VIEWER.login ? store.getRepo(owner, repoName) : undefined;
  if (!repo) return notFound();
  const rest = segments.slice(3);
  const repoPath = `/api/v3/repos/${owner}/${repoName}`;

  // Repository itself.
  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoJson(repo));
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        store.deleteRepo(repo.owner, repo.name);
        repo.name = body.name;
        store.repos.set(store.repoKey(repo.owner, repo.name), repo);
      }
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) repo.defaultBranch = body.default_branch;
      repo.updatedAt = tick();
      return json(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204 };
    }
    return notFound();
  }

  // Branches.
  if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: `${repoPath}/commits/${sha}` }, protected: false }));
    return json(200, branches);
  }
  if (rest[0] === 'branches' && rest.length === 2 && method === 'GET') {
    const branch = rest[1] as string;
    const sha = store.branchTip(repo, branch);
    if (!sha) return notFound();
    return json(200, { name: branch, commit: commitJson(store, sha), protected: false, _links: {} });
  }

  // Git refs.
  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2) {
    if (method === 'POST') {
      const ref = bodyString(body, 'ref');
      const sha = bodyString(body, 'sha');
      if (!ref || !sha || !store.readCommit(sha)) return unprocessable('ref and a commit sha are required');
      if (repo.refs.has(ref)) return unprocessable('Reference already exists');
      repo.refs.set(ref, sha);
      return json(201, { ref, node_id: `REF_${ref}`, url: `${repoPath}/git/refs/${ref.replace('refs/', '')}`, object: { type: 'commit', sha, url: '' } });
    }
    if (method === 'GET') {
      const refs = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, node_id: `REF_${ref}`, url: '', object: { type: 'commit', sha, url: '' } }));
      return json(200, refs);
    }
    return notFound();
  }
  if (rest[0] === 'git' && rest[1] === 'ref' && method === 'DELETE') {
    const ref = `refs/${rest.slice(2).join('/')}`;
    if (!repo.refs.delete(ref)) return notFound();
    return { status: 204 };
  }

  // Commits.
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const startRef = query.get('sha') ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, startRef);
    if (!tip) return json(200, []);
    const commits: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0 && commits.length < 500) {
      const sha = queue.shift() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const entry = commitJson(store, sha);
      if (!entry) continue;
      commits.push(entry);
      const commit = store.readCommit(sha);
      if (commit) queue.push(...commit.parents);
    }
    const { page } = paginate(commits, query);
    return json(200, page);
  }
  if (rest[0] === 'commits' && rest.length === 2 && method === 'GET') {
    const entry = commitJson(store, rest[1] as string);
    return entry ? json(200, entry) : notFound();
  }

  // Contents.
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    return handleContents(store, repo, req, path, repoPath);
  }

  // Labels.
  if (rest[0] === 'labels' && rest.length === 1) {
    if (method === 'GET') return json(200, [...repo.labels.keys()].map((name) => labelJson(repo, name)));
    if (method === 'POST') {
      const name = bodyString(body, 'name');
      if (!name) return unprocessable('name is required');
      if (repo.labels.has(name)) return unprocessable('name has already been taken');
      repo.labels.set(name, { name, color: (bodyString(body, 'color') ?? 'ededed').replace(/^#/, ''), description: bodyString(body, 'description') ?? '' });
      return json(201, labelJson(repo, name));
    }
    return notFound();
  }

  // Issues and comments.
  if (rest[0] === 'issues') return handleIssues(store, repo, req, rest.slice(1), repoPath);

  // Pull requests.
  if (rest[0] === 'pulls') return handlePulls(store, repo, req, rest.slice(1), repoPath);

  return notFound();
}

// -------------------------------------------------------------------------------------------
// Contents

function handleContents(store: Store, repo: Repo, req: RestRequest, path: string, repoPath: string): RestResult {
  const { method, query, body } = req;

  if (method === 'PUT') {
    const message = bodyString(body, 'message') ?? '';
    const contentB64 = bodyString(body, 'content');
    if (contentB64 === undefined) return unprocessable('content is required');
    const branch = bodyString(body, 'branch') ?? repo.defaultBranch;
    const tip = store.branchTip(repo, branch);
    const files = tip ? store.flattenTree(tip) : new Map<string, { mode: string; sha: string }>();
    const existing = files.get(path);
    const sentSha = bodyString(body, 'sha');
    if (existing && sentSha !== undefined && sentSha !== existing.sha) {
      return json(409, { message: `${path} does not match the given sha` });
    }
    const data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
    const blobSha = store.writeBlob(data);
    const commitSha = commitFiles(store, repo, branch, new Map([[path, { mode: existing?.mode ?? '100644', sha: blobSha }]]), message);
    const status = existing ? 200 : 201;
    return json(status, {
      content: {
        name: path.split('/').pop() as string,
        path,
        sha: blobSha,
        size: data.length,
        type: 'file',
        encoding: 'base64',
        url: `${repoPath}/contents/${path}`,
        html_url: '',
        git_url: '',
        download_url: '',
      },
      commit: { sha: commitSha, url: '', html_url: '', author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email }, message, tree: { sha: '', url: '' }, parents: [] },
    });
  }

  if (method === 'DELETE') {
    const branch = bodyString(body, 'branch') ?? repo.defaultBranch;
    const tip = store.branchTip(repo, branch);
    if (!tip) return notFound();
    const files = store.flattenTree(tip);
    const existing = files.get(path);
    if (!existing) return notFound();
    const sentSha = bodyString(body, 'sha');
    if (sentSha !== undefined && sentSha !== existing.sha) return json(409, { message: `${path} does not match the given sha` });
    const commitSha = commitFiles(store, repo, branch, new Map([[path, null]]), bodyString(body, 'message') ?? '');
    return json(200, { content: null, commit: { sha: commitSha, url: '', message: bodyString(body, 'message') ?? '' } });
  }

  if (method === 'GET') {
    const ref = query.get('ref') ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, ref);
    if (!tip) return notFound();
    const files = store.flattenTree(tip);
    const file = files.get(path);
    if (file) {
      const obj = store.readObject(file.sha);
      const data = obj?.data ?? Buffer.alloc(0);
      return json(200, {
        name: path.split('/').pop() as string,
        path,
        sha: file.sha,
        size: data.length,
        type: 'file',
        encoding: 'base64',
        content: data.toString('base64'),
        url: `${repoPath}/contents/${path}`,
        html_url: '',
        git_url: '',
        download_url: '',
      });
    }
    // Directory listing: entries directly under path ('' is the root).
    const prefix = path === '' ? '' : `${path}/`;
    const seen = new Map<string, { type: 'file' | 'dir'; sha: string; size: number }>();
    for (const [filePath, entry] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const restPath = filePath.slice(prefix.length);
      const slash = restPath.indexOf('/');
      if (slash === -1) {
        const obj = store.readObject(entry.sha);
        seen.set(restPath, { type: 'file', sha: entry.sha, size: obj?.data.length ?? 0 });
      } else {
        const dirName = restPath.slice(0, slash);
        if (!seen.has(dirName)) seen.set(dirName, { type: 'dir', sha: dirTreeSha(store, tip, `${prefix}${dirName}`), size: 0 });
      }
    }
    if (path !== '' && seen.size === 0) return notFound();
    const listing = [...seen.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, entry]) => ({
        name,
        path: `${prefix}${name}`,
        sha: entry.sha,
        size: entry.size,
        type: entry.type,
        url: `${repoPath}/contents/${prefix}${name}`,
        html_url: '',
        git_url: '',
        download_url: null,
      }));
    return json(200, listing);
  }

  return notFound();
}

/** The tree sha of a directory inside a commit (for directory listings). */
function dirTreeSha(store: Store, commitSha: string, dirPath: string): string {
  const commit = store.readCommit(commitSha);
  if (!commit) return '';
  let treeSha = commit.tree;
  for (const part of dirPath.split('/')) {
    const obj = store.readObject(treeSha);
    if (!obj || obj.type !== 'tree') return '';
    const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    if (!entry) return '';
    treeSha = entry.sha;
  }
  return treeSha;
}

// -------------------------------------------------------------------------------------------
// Issues

function labelNamesOf(repo: Repo, body: Record<string, unknown>): string[] | null {
  const raw = body.labels;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const item of raw) {
    const name = typeof item === 'string' ? item : typeof (item as { name?: unknown })?.name === 'string' ? ((item as { name: string }).name as string) : null;
    if (name === null || !repo.labels.has(name)) return null;
    names.push(name);
  }
  return names;
}

function handleIssues(store: Store, repo: Repo, req: RestRequest, rest: string[], repoPath: string): RestResult {
  const { method, query, body } = req;

  if (rest.length === 0) {
    if (method === 'POST') {
      const title = bodyString(body, 'title');
      if (!title) return unprocessable('title is required');
      const labels = labelNamesOf(repo, body);
      if (labels === null) return json(422, { message: 'Validation Failed: one or more labels do not exist' });
      const now = tick();
      const issue: IssueRec = {
        number: repo.nextNumber++,
        title,
        body: bodyString(body, 'body') ?? '',
        state: 'open',
        labels,
        userLogin: VIEWER.login,
        createdAt: now,
        updatedAt: now,
        comments: [],
        isPull: false,
      };
      repo.issues.set(issue.number, issue);
      return json(201, issueJson(repo, issue));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()].filter((issue) => !issue.isPull);
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { page } = paginate(list, query);
      return json(200, page.map((issue) => issueJson(repo, issue)));
    }
    return notFound();
  }

  const number = Number(rest[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (!issue) return notFound();

  if (rest.length === 1) {
    if (method === 'GET') return json(200, issueJson(repo, issue));
    if (method === 'PATCH') {
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (body.labels !== undefined) {
        const labels = labelNamesOf(repo, body);
        if (labels === null) return json(422, { message: 'Validation Failed: one or more labels do not exist' });
        issue.labels = labels;
      }
      issue.updatedAt = tick();
      // Keep a mirrored pull record's state in step.
      const pull = repo.pulls.get(issue.number);
      if (pull && !pull.merged) pull.state = issue.state;
      return json(200, issueJson(repo, issue));
    }
    return notFound();
  }

  if (rest[1] === 'comments' && rest.length === 2) {
    if (method === 'POST') {
      const text = bodyString(body, 'body');
      if (text === undefined) return unprocessable('body is required');
      const comment = { id: store.nextCommentId(), body: text, userLogin: VIEWER.login, createdAt: tick() };
      issue.comments.push(comment);
      return json(201, commentJson(repo, issue, comment.id));
    }
    if (method === 'GET') return json(200, issue.comments.map((c) => commentJson(repo, issue, c.id)));
    return notFound();
  }

  if (rest[1] === 'labels' && method === 'POST') {
    const labels = labelNamesOf(repo, body);
    if (labels === null) return json(422, { message: 'Validation Failed: one or more labels do not exist' });
    issue.labels = [...new Set([...issue.labels, ...labels])];
    return json(200, issue.labels.map((name) => labelJson(repo, name)));
  }

  void repoPath;
  return notFound();
}

// -------------------------------------------------------------------------------------------
// Pull requests

function handlePulls(store: Store, repo: Repo, req: RestRequest, rest: string[], repoPath: string): RestResult {
  const { method, query, body } = req;
  void repoPath;

  if (rest.length === 0) {
    if (method === 'POST') {
      const title = bodyString(body, 'title');
      const headRaw = bodyString(body, 'head');
      const baseRaw = bodyString(body, 'base');
      if (!title || !headRaw || !baseRaw) return unprocessable('title, head and base are required');
      const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
      const base = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
      if (!store.branchTip(repo, head)) return unprocessable(`head branch ${head} does not exist`);
      if (!store.branchTip(repo, base)) return unprocessable(`base branch ${base} does not exist`);
      const existing = [...repo.pulls.values()].find((p) => p.headRef === head && p.baseRef === base && p.state === 'open');
      if (existing) return unprocessable('A pull request already exists for this head and base');
      const now = tick();
      const number = repo.nextNumber++;
      const pull: PullRec = {
        number,
        title,
        body: bodyString(body, 'body') ?? '',
        state: 'open',
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
        title,
        body: pull.body,
        state: 'open',
        labels: [],
        userLogin: VIEWER.login,
        createdAt: now,
        updatedAt: now,
        comments: [],
        isPull: true,
      });
      return json(201, pullJson(store, repo, pull));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.number - a.number);
      const { page } = paginate(list, query);
      return json(200, page.map((p) => pullJson(store, repo, p)));
    }
    return notFound();
  }

  const number = Number(rest[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (!pull) return notFound();

  if (rest.length === 1) {
    if (method === 'GET') return json(200, pullJson(store, repo, pull));
    if (method === 'PATCH') {
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'open' || body.state === 'closed') {
        pull.state = body.state;
        const mirror = repo.issues.get(pull.number);
        if (mirror) mirror.state = body.state;
      }
      pull.updatedAt = tick();
      return json(200, pullJson(store, repo, pull));
    }
    return notFound();
  }

  if (rest[1] === 'files' && rest.length === 2 && method === 'GET') {
    const trees = pullTrees(store, repo, pull);
    if (!trees) return json(200, []);
    const files: Record<string, unknown>[] = [];
    const paths = new Set([...trees.base.keys(), ...trees.theirs.keys()]);
    for (const path of [...paths].sort()) {
      const before = trees.base.get(path);
      const after = trees.theirs.get(path);
      if (before?.sha === after?.sha) continue;
      const oldText = before ? (store.readObject(before.sha)?.data.toString('utf8') ?? '') : '';
      const newText = after ? (store.readObject(after.sha)?.data.toString('utf8') ?? '') : '';
      const counts = diffCounts(oldText, newText);
      files.push({
        sha: after?.sha ?? before?.sha ?? '',
        filename: path,
        status: !before ? 'added' : !after ? 'removed' : 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      });
    }
    return json(200, files);
  }

  if (rest[1] === 'merge' && rest.length === 2 && method === 'PUT') {
    const method2 = bodyString(body, 'merge_method') ?? 'merge';
    const outcome = performMerge(store, repo, pull, method2, {
      commitTitle: bodyString(body, 'commit_title'),
      commitMessage: bodyString(body, 'commit_message'),
    });
    if (!outcome.ok) return json(405, { message: outcome.message });
    return json(200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
  }

  return notFound();
}

/** Merge a pull request (shared by REST and GraphQL). */
export function performMerge(
  store: Store,
  repo: Repo,
  pull: PullRec,
  method: string,
  options: { commitTitle?: string; commitMessage?: string } = {},
): { ok: true; sha: string } | { ok: false; message: string } {
  if (pull.merged) return { ok: false, message: 'Pull Request is not mergeable: it has already been merged' };
  if (pull.state !== 'open') return { ok: false, message: 'Pull Request is not mergeable: it is closed' };
  const trees = pullTrees(store, repo, pull);
  if (!trees) return { ok: false, message: 'Pull Request is not mergeable' };
  const outcome = threeWayMerge(trees.base, trees.ours, trees.theirs);
  if (outcome.conflict) return { ok: false, message: 'Pull Request is not mergeable: conflicts must be resolved first' };
  const baseTip = store.branchTip(repo, pull.baseRef) as string;
  const headTip = store.branchTip(repo, pull.headRef) as string;
  const tree = store.buildTree(outcome.files);
  const identity = apiIdentity();
  let mergeSha: string;
  if (method === 'merge') {
    mergeSha = store.writeCommit({
      tree,
      parents: [baseTip, headTip],
      author: identity,
      committer: identity,
      message: options.commitMessage ?? `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`,
    });
  } else {
    const title = options.commitTitle ?? `${pull.title} (#${pull.number})`;
    mergeSha = store.writeCommit({
      tree,
      parents: [baseTip],
      author: identity,
      committer: identity,
      message: options.commitMessage ? `${title}\n\n${options.commitMessage}` : title,
    });
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = tick();
  pull.updatedAt = pull.mergedAt;
  pull.mergeCommitSha = mergeSha;
  const mirror = repo.issues.get(pull.number);
  if (mirror) {
    mirror.state = 'closed';
    mirror.updatedAt = pull.mergedAt;
  }
  repo.updatedAt = tick();
  return { ok: true, sha: mergeSha };
}
