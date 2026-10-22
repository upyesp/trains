## Agent skills

### Issue tracker

Issues live as GitHub issues in `upyesp/trains` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Using the default five canonical triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Codebase graph

Structural questions go through the codebase-memory graph before grep.

- Project name: `Users-pete-Developer-code-trains`
- Reindex after large refactors: `index_repository(repo_path="<repo root>")`
- `get_architecture` for entry points, packages and hotspots; `search_graph(label="Function", name_pattern=".*Pattern.*")` to locate symbols; `get_code_snippet` for exact line ranges; `trace_path(direction="inbound")` for impact
- Always constrain degree and dead-code queries with `label="Function"`. Unfiltered, they return folders, YAML and doc files and are unusable
- For fan-in/fan-out rankings use `query_graph` Cypher with `count(r)`, not `search_graph(min_degree=...)` — the degree filter has been observed to return unfiltered rows
- `detect_changes()` maps the working diff to affected symbols before committing
