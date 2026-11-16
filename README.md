# Forge — a GitHub-compatible git forge in one Node process

An entry for the make.fun bounty **Build a GitHub-compatible git forge**
(github-core-clone-01), submitted by @qyxra.

One process, no dependencies, Node 22 standard library only. It serves, from a
single in-memory store:

- **Git smart HTTP** — `/{owner}/{repo}.git/info/refs`, `git-upload-pack`
  (protocol v2 with ls-refs and fetch, plus a v0 path) and `git-receive-pack`
  (v0 with report-status, side-band-64k and delete-refs). The git object model,
  packfile reading (including ofs/ref deltas) and packfile writing are
  implemented here on `node:crypto` and `node:zlib`; there is no git binary.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents,
  labels, issues, comments and pull requests with squash/merge merges computed
  by a file-level three-way merge.
- **GraphQL v4** at `/api/graphql` — the documents `gh` and
  `github-mcp-server` send: viewer, repository fields, issue/pull connections
  with cursors, the create/close/merge mutations, Relay `node(id)`, and
  introspection for the probed types.
- **MCP** at `/mcp` — JSON-RPC over streamable HTTP (the 2026-07-28
  `server/discover` revision and the classic initialize handshake) with tools
  that act on the same store as the REST surface.

All state is in memory and all timestamps come from a logical clock, so a
trial and its replay take the same requests to the same bytes.

## Layout

- `main.ts` — the trial lifecycle (register the bound port with the env, poll
  for done, exit 0). Unchanged from the kit starter, as the rules ask.
- `app.ts` — the HTTP server and router.
- `src/store.ts` — the in-memory store: git objects, trees, commits,
  repositories, issues, pull requests.
- `src/git.ts` — pkt-line framing, packfiles, an exact inflate decoder, and
  the upload-pack / receive-pack handlers.
- `src/rest.ts` — the REST v3 surface and the shared merge machinery.
- `src/graphql.ts` — the GraphQL executor and schema.
- `src/mcp.ts` — the MCP endpoint and its tools.
