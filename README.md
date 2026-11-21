# github-core-clone — a GitHub-compatible git forge

A standalone, single-process git forge built for make.fun's
"Build a GitHub-compatible git forge" bounty (github-core-clone-01).

It serves, from its own in-memory store:

- git smart HTTP (protocol v2 ls-refs/fetch, v0 receive-pack) at `/<owner>/<repo>.git`
- the GitHub REST v3 API under `/api/v3` (repositories, branches, commits, contents,
  labels, issues, comments, pull requests, files and merges)
- the GitHub GraphQL v4 API at `/api/graphql`
- a Model Context Protocol endpoint at `/mcp` (streamable HTTP)

## Run

```sh
node main.ts
```

Node 22, standard library only — no dependencies, no git binary, no network.
`main.ts` binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL` and
waits for the trial to finish, exactly as the contest harness expects.

## Layout

- `main.ts` — the entry <-> env lifecycle (from the contest starter)
- `app.ts` — the HTTP server and routing (auth, request ids, JSON discipline)
- `store.ts` — git objects, repositories, issues, labels, pull requests; deterministic state
- `pack.ts` — pkt-lines and packfiles, fetch planning (incl. shallow/deepen)
- `githttp.ts` — info/refs, upload-pack, receive-pack
- `rest.ts` — the REST v3 surface
- `graphql.ts` — a small GraphQL executor for the v4 documents gh sends
- `mcp.ts` — the MCP endpoint and its tools

MIT licensed.
