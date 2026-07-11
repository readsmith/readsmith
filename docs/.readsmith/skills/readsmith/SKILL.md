---
name: readsmith
description: Readsmith is a self-hosted, Fair Source documentation platform that
  builds a static docs site from Markdown/MDX with a generated OpenAPI
  reference, hybrid search, Ask AI, MCP server, and agent-ready outputs
  (llms.txt, per-page Markdown, skill.md). Use when a user asks to set up,
  configure, deploy, or upgrade Readsmith docs; author pages/components
  (callouts, tabs, steps, cards, diagrams, code groups, snippets, variables);
  wire up the API reference (openapi/openapi-schema frontmatter, Operation
  embeds); configure AI search/Ask AI/MCP; call Readsmith's search, ask,
  feedback, capabilities, or health endpoints; troubleshoot rate limits, CSP,
  storage roots, or self-host env vars; or generate/author an Agent Skill for a
  Readsmith site.
metadata:
  readsmith-proj: readsmith
  version: "1.0"
  readsmith-generated: 200b614aaa51d68885ef87fe785f702340d5695997a6f90ea561dc1484a831ac
---

# Readsmith

## Product summary
Readsmith is a Fair Source (FSL-1.1-MIT) documentation platform that compiles a repository of Markdown/MDX into an immutable, byte-reproducible static site, self-hosted via one Docker Compose stack (app + Postgres/pgvector) with docs primarily described at https://readsmith.dev/docs. It generates an OpenAPI-driven API reference (hybrid operation pages, schema pages, `<Operation>` embeds), hybrid (keyword + vector) search and Ask AI over your own model keys, a read-only MCP server, and agent-facing outputs (`/llms.txt`, `/llms-full.txt`, per-page `/md/...`, `/skill.md`). Configuration lives entirely in a build-time `docs.yaml`/`docs.json` (no runtime dashboard, no keys in config); without a connected database the site still serves pages, navigation, the API reference, and agent outputs, but search and Ask AI go off.

## When to use
- Setting up, deploying, or upgrading a self-hosted Readsmith instance (Docker Compose, env vars, reverse proxy, backups)
- Authoring or restructuring docs content: pages, frontmatter, navigation, snippets/variables, components (callouts, tabs, steps, cards, accordions, frames, code groups, diagrams, inline badges/tooltips/kbd, updates)
- Wiring the generated API reference: `openapi`/`openapi-schema` frontmatter, `<Operation>` embeds, `apiReference` config, single vs pages layout
- Configuring or querying AI features: search API, Ask AI, MCP tools, capability/health checks, rate limits
- Generating or hand-authoring an Agent Skill for a Readsmith-built docs site
- Debugging gotchas: build warnings, degraded search, missing keys, CSP, storage roots, rate-limit headers

## Quick reference

### Core URLs and agent outputs
| Item | Value |
|---|---|
| Docs base URL | https://readsmith.dev/docs |
| Directory export | `curl https://readsmith.dev/docs/llms.txt` |
| Full-site Markdown export | `/llms-full.txt` |
| Per-page Markdown | `/md/<page-path>` (e.g. `/md/ai/agent-outputs`) |
| Generated Agent Skill | `curl https://readsmith.dev/docs/skill.md` |
| Skill discovery | `/skill.md`, `/.well-known/skills/index.json`, `/.well-known/skills/<name>/SKILL.md` |
| Hand-authored skills location | `.readsmith/skills/<name>/SKILL.md` at content root |
| MCP endpoint | `/mcp` (canonical: `/_readsmith/mcp`; alias set via `mcp.path`) |

### API endpoints (base `https://readsmith.dev/docs`, API version 0.1.0, no auth, all rate-limited per IP)
| Method & path | Purpose | Responses |
|---|---|---|
| POST `/_readsmith/api/search` | Hybrid search | 200, 400, 429, 503 |
| POST `/_readsmith/api/ask` | Ask AI (SSE stream) | 200 (text/event-stream), 400, 429, 503 |
| POST `/_readsmith/api/ai/feedback` | Rate an answer | 200, 400, 503 |
| GET `/_readsmith/api/ai/capabilities` | Feature flags | 200 |
| GET `/_readsmith/api/health` | Health check | 200, 503 |

### Search / Ask request fields
| Field | Type | Rules |
|---|---|---|
| query | string | required, length 1-2000 |
| version | string | optional, defaults to current |
| locale | string | optional, defaults to `en` |

### SearchHit fields
| Field | Type | Notes |
|---|---|---|
| id, kind, title, snippet, url, anchor, headerPath, method, path, score | mixed | all required except `text`; `kind` is `doc` or `endpoint`; `snippet` is preview only, not grounding |
| text | string | optional, full chunk text when requested |

### Capabilities / health fields
| Field | Meaning |
|---|---|
| `search` | true when a database is connected |
| `vectorSearch` | true when an embedding key resolves |
| `askAi` | true when Ask AI enabled and a chat key resolves |
| `status` (health) | `ok` or `degraded` |
| `database` (health) | `up`, `down`, or `disabled` |

### Key config (docs.yaml)
| Key | Default | Notes |
|---|---|---|
| site.name | (required) | only required key |
| site.url | unset | canonical base for sitemap/RSS/llms.txt |
| content.root | `.` | page directory |
| content.include | `**/*.md`, `**/*.mdx` | discovery globs |
| content.exclude | (defaults below) | merges, never replaces |
| content.home | unset | may escape content root, never repo |
| apiReference.spec | (required to enable) | path to OpenAPI file |
| apiReference.path | `/api-reference` | mount URL |
| apiReference.layout | `single` | or `pages` |
| assets | unset | `[{from, to}]`, `from` may escape content root, never repo |
| links.repo / links.branch | unset / `main` | resolves off-root relative links |
| variables | unset | `{{name}}` in .md, `{name}` in .mdx |
| branding | `true` | set `false` to remove badge |
| mcp.path | `/mcp` | alias only; canonical endpoint always answers |
| ai.chat.provider/model | unset | `openai`, `anthropic`, `google`, `gateway` |
| ai.embedding.provider/model | unset | `openai`, `google`, `gateway` |
| ai.search.rrfK | `60` | rank-fusion constant |
| ai.search.topK | `8` | results per search |
| ai.askAi.enabled | `true` | search stays independent |
| ai.askAi.maxSteps | `4` | tool-use steps |
| ai.askAi.maxOutputTokens | `1024` | answer ceiling |
| ai.askAi.timeoutMs | `30000` | per-question budget |
| ai.limits.ask/search/mcp | `10`/`60`/`60` per min | `{limit, windowMs}` |
| security.csp.* | unset | adds to strict default, never replaces |

Always-excluded content patterns: `**/node_modules/**`, `**/.git/**`, `snippets/**`.

### Self-host environment variables
| Variable | Default | Purpose |
|---|---|---|
| READSMITH_CONTENT | `apps/web/content` | content directory (holds docs.yaml) |
| DATABASE_URL | unset | Postgres connection; unset = docs-only mode |
| PORT | `4321` | published app port |
| STORAGE_ROOT | `apps/web/.readsmith` | compiled bundle store |
| STORAGE_DRIVER | `local` | only self-host driver |
| READSMITH_STORAGE_ROOT | unset | persisted spec blobs (mounted volume) |
| READSMITH_AI_CHAT_KEY / _EMBEDDING_KEY / _RERANK_KEY | unset | role-override keys, take precedence |
| OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / AI_GATEWAY_API_KEY | unset | provider-native keys |
| READSMITH_RATE_LIMIT | (master switch) | `true`/`false` |
| READSMITH_RATE_LIMIT_ASK/_SEARCH/_MCP | 10/60/60 per min | format `10` or `10/30` |
| READSMITH_TRUSTED_IP_HEADER | unset | must be proxy-controlled only |
| READSMITH_CSP_IMG_SRC/_CONNECT_SRC/_FONT_SRC/_FRAME_SRC/_FRAME_ANCESTORS | unset | build-time only |
| CACHE_DRIVER / READSMITH_LOG_LEVEL / READSMITH_WORKER_CONCURRENCY / READSMITH_MIGRATIONS_DIR | memory/info/2/(resolved) | operations |
| POSTGRES_USER/PASSWORD/DB | (compose-only) | assemble DATABASE_URL |

### Rate limits (default, per client IP)
| Feature | Limit |
|---|---|
| Ask AI | 10 requests/minute |
| Search | 60 requests/minute |
| MCP | 60 requests/minute |

## Decision guidance

### API reference layout
| Option | When |
|---|---|
| single (default) | API is small; one continuous reference page, `#operationId` anchors |
| pages | Operations deserve own URLs, search results, nav tab, prev/next |

### Diagram vs image
| Option | When |
|---|---|
| Mermaid diagram | Visual is a graph (flowchart, relationships); diffs in review, restyles with theme |
| Image in Frame | Screenshots, photography, hand-drawn art |

### File type: .md vs .mdx
| Option | When |
|---|---|
| .md | Also rendered on GitHub or elsewhere; degrades gracefully; supports `{{var}}` and `<Snippet>` only |
| .mdx | Site-only pages needing full component library, `{var}` syntax |

### Callout severity
| Option | When |
|---|---|
| Note | Skippable enriching detail |
| Info | Context needed to proceed correctly |
| Tip | Best practice or recommendation |
| Warning | Reversible harm, surprises, data risk |
| Danger | Irreversible or security-relevant harm |
| Check | Confirmation at end of a procedure |

### Badge variant
| Option | When |
|---|---|
| unset | Neutral label |
| `new` / `tip` | Positive: fresh or recommended |
| `warning` | Caution: deprecated, experimental |
| `accent` | Brand-colored emphasis |

### Operation embed vs full reference
| Option | When |
|---|---|
| `<Operation>` embed | Narrative page walks through three or four fully specified calls |
| Plain Markdown (no embed) | Docs also render on GitHub (tags degrade to raw text) |
| `apiReference.layout: pages` | Need one operation per page across many operations |

### Tabs vs alternatives
| Option | When |
|---|---|
| Tabs | Reader needs exactly one of the alternatives |
| Headings | Reader should read all content |
| Accordion | Content is optional depth |
| Code group | Alternatives are code-only |

### Steps vs plain list
| Option | When |
|---|---|
| Steps (numbered) | Order carries information |
| Plain list | Items are independent options, not a march |

### Navigation: auto vs explicit
| Option | When |
|---|---|
| Auto-navigation | File tree already tells the right story |
| Explicit `navigation`/`tabs` | Auto sidebar stops matching mental model, need curated order |

### Config file format
| Option | When |
|---|---|
| `docs.yaml` / `docs.yml` | Native shape |
| `docs.json` | Migrating from Mintlify-compatible setup |

### appearance.default
| Option | When |
|---|---|
| `system` (default) | Follow visitor's OS scheme |
| `light` / `dark` | Pin first-visit scheme (visitor toggle still persists and wins) |

### Local run method
| Option | When |
|---|---|
| Docker with Compose plugin | Standard path |
| Node.js 22+ and pnpm | Local preview without containers |

### Skill generation model
| Option | When |
|---|---|
| Strongest model | For `--model` flag during `skill:generate`; generation is rare, quality of extracted gotchas matters |

## Workflow

### 1. Quickstart with Docker
1. `git clone https://github.com/readsmith/readsmith`
2. `cd readsmith`
3. `cp .env.example .env`
4. Set `POSTGRES_PASSWORD` in `.env` (other defaults work)
5. `docker compose up`
6. Visit `http://localhost:4321`

### 2. Local preview without containers
1. `git clone https://github.com/readsmith/readsmith`
2. `cd readsmith`
3. `pnpm install`
4. `cd apps/web && pnpm dev`
5. Site serves at `http://localhost:4321`

### 3. Point Readsmith at your own docs
1. Set `READSMITH_CONTENT` to your content directory
2. Restart

### 4. Create a hybrid API operation page
1. Add frontmatter: `title` and `openapi: "METHOD /path"`
2. Write prose in the page body
3. Generated authorization/parameters/request body/responses/console render around it

### 5. Create a data-model (schema) page
1. Add frontmatter: `title` and `openapi-schema: "SchemaName"`
2. Write prose describing the model
3. Generated fields/required flags/enums/nested objects render after

### 6. Set up the generated API reference
1. Set `apiReference.spec` to the OpenAPI file path (relative to content root) in `docs.yaml`
2. Optionally set `apiReference.layout` to `single` or `pages`
3. Reference builds automatically with the site

### 7. Configure and index AI search / Ask AI
1. Add `ai.chat.provider`/`ai.chat.model` and `ai.embedding.provider`/`ai.embedding.model` to `docs.yaml`
2. Set provider API keys via environment variables only (never in config)
3. Run `pnpm ai:index`
4. Re-run indexing after every deploy (manual step; not automatic on boot)

### 8. Author an Agent Skill by hand
1. Create `.readsmith/skills/<name>/` at content root
2. Add `SKILL.md` with `name` (matching directory) and `description` frontmatter
3. Write the body
4. Hand-authored skills always win over generated ones

### 9. Generate an Agent Skill
1. `pnpm skill:generate --dry-run` to preview
2. `pnpm skill:generate --model <strongest-model>` to generate for real
3. Generator reads the built site, verifies every claimed link exists, writes into `.readsmith/skills/`
4. Review the diff, edit, commit; next build serves the committed skill

### 10. Deploy to production
1. `git clone`, `cd readsmith`, `cp .env.example .env`
2. Set real `POSTGRES_PASSWORD`, point `READSMITH_CONTENT` at docs, keep `.env` out of version control
3. `docker compose up -d --build`
4. Verify: `curl -s https://readsmith.dev/docs/llms.txt | head -3`
5. Put a reverse proxy (Caddy/nginx) in front for TLS and domain

### 11. Pass real client IP through a proxy
1. Configure the proxy to set a header only it controls (e.g. `X-Real-IP`, `CF-Connecting-IP`)
2. Set `READSMITH_TRUSTED_IP_HEADER` to that header name (never a client-settable header)

### 12. Upgrade a self-hosted deployment
1. `git pull --tags`
2. Read the changelog for required actions
3. `docker compose up -d --build` (migrations run automatically on start)
4. Load the site, run a search, spot-check `/llms.txt`

### 13. Roll back
1. Keep the last known-good image tag
2. Check release notes if crossing a migration boundary
3. `docker compose up -d` with the previous tag

### 14. Back up state
1. Nightly: `docker compose exec db pg_dump -U readsmith readsmith | gzip > backup-$(date +%F).sql.gz`
2. Also back up the `storage-data` volume (spec blobs)
3. Content in git is already backed up; the site rebuilds from it

## Common gotchas
- Hidden pages are excluded from `/llms-full.txt` and the sidebar, even if listed in `navigation`
- Overwriting a hand-written SKILL.md without the generated marker fails unless `--force` is passed
- `skill:generate` never runs during a build and skips unchanged content, so re-running produces no update
- MCP is read-only; `list_endpoints`/`get_endpoint` only appear when an API reference is configured
- `pnpm ai:index` is manual and must be re-run after every deploy; the compose image only runs migrations on boot
- `degraded: true` in search can appear even with a working embedding key if the provider is down at request time
- The search `snippet` field is preview-only; use MCP `search_docs` for full-text grounding, not `snippet`
- Claiming the same OpenAPI operation or schema on two pages is a build error; first claim wins
- A page with both `openapi` and `openapi-schema` keeps the operation with a build warning
- An `openapi-schema` value matching no schema (or `<Operation op>` matching nothing) renders a visible danger callout, not a silent failure
- Untagged code fences render as plain text in both themes
- A failed Mermaid parse falls back to raw source text, not a build failure
- Asset mounts copy the entire source directory, not just referenced files
- `{{version}}` only works in plain Markdown; in MDX it parses as an expression with a build warning
- `hidden: true` implies `noindex` unless `noindex: false` is set explicitly
- Two sites must never share one storage root (`STORAGE_ROOT`/`READSMITH_STORAGE_ROOT`); the second overwrites the first's bundle
- Setting `READSMITH_TRUSTED_IP_HEADER` to a client-settable header on a directly exposed app defeats rate limiting
- CSP env vars (`READSMITH_CSP_*`) are read at build time only, not on a running container
- Behind a CDN, failing to exclude `/_readsmith/` POST routes from caching breaks search/Ask AI; `/llms.txt`, `/skill.md`, `/.well-known/*` must pass through untouched
- Content is baked into the image at build time; publishing changes requires a rebuild, not a live edit
- Migrations are forward-only; check release notes before rolling back across a migration boundary
- `.env` must never be committed; only `.env.example` with no real values belongs in version control
- Without a database, search and Ask AI stay off even though pages, navigation, and agent outputs still work

## Verification checklist
- [ ] `curl -s https://<site>/llms.txt | head -3` returns content (agent outputs are live)
- [ ] `GET /_readsmith/api/health` returns `status: ok` and expected `database` value (`up`/`down`/`disabled`)
- [ ] `GET /_readsmith/api/ai/capabilities` shows `search`/`vectorSearch`/`askAi` matching configured keys and database state
- [ ] Model keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `AI_GATEWAY_API_KEY`, or role overrides) are set via environment, never in `docs.yaml`
- [ ] `pnpm ai:index` has been run after the latest deploy if search/Ask AI content changed
- [ ] No two Readsmith sites share the same `STORAGE_ROOT` / `READSMITH_STORAGE_ROOT`
- [ ] Reverse proxy passes `/_readsmith/` POST routes, `/llms.txt`, `/skill.md`, `/.well-known/*` through uncached
- [ ] `READSMITH_TRUSTED_IP_HEADER`, if set, names a header only your proxy controls
- [ ] Hybrid/schema pages each claim a unique `openapi`/`openapi-schema` value with no build warnings
- [ ] `.env` is not committed; only `.env.example` is
- [ ] Backups exist for the database (or `db-data` volume) and `storage-data` volume

## Resources
- https://readsmith.dev/docs/what-is-readsmith
- https://readsmith.dev/docs/quickstart
- https://readsmith.dev/docs/configuration/overview
- https://readsmith.dev/docs/configuration/settings-reference
- https://readsmith.dev/docs/configuration/navigation
- https://readsmith.dev/docs/configuration/theming
- https://readsmith.dev/docs/authoring/pages
- https://readsmith.dev/docs/authoring/markdown
- https://readsmith.dev/docs/authoring/snippets-and-variables
- https://readsmith.dev/docs/authoring/images-and-links
- https://readsmith.dev/docs/authoring/code-blocks
- https://readsmith.dev/docs/authoring/diagrams
- https://readsmith.dev/docs/components/overview
- https://readsmith.dev/docs/components/callouts
- https://readsmith.dev/docs/components/cards
- https://readsmith.dev/docs/components/code-groups
- https://readsmith.dev/docs/components/diagrams
- https://readsmith.dev/docs/components/frames
- https://readsmith.dev/docs/components/inline
- https://readsmith.dev/docs/components/operation
- https://readsmith.dev/docs/components/steps
- https://readsmith.dev/docs/components/tabs
- https://readsmith.dev/docs/components/updates
- https://readsmith.dev/docs/components/accordions
- https://readsmith.dev/docs/api-reference-guide/setup
- https://readsmith.dev/docs/api-reference-guide/hybrid-pages
- https://readsmith.dev/docs/api-reference-guide/schema-pages
- https://readsmith.dev/docs/api-reference
- https://readsmith.dev/docs/api-reference/askdocs
- https://readsmith.dev/docs/api-reference/sendfeedback
- https://readsmith.dev/docs/api-reference/getcapabilities
- https://readsmith.dev/docs/api-reference/gethealth
- https://readsmith.dev/docs/ai/search-and-ask
- https://readsmith.dev/docs/ai/search-api
- https://readsmith.dev/docs/ai/mcp
- https://readsmith.dev/docs/ai/agent-outputs
- https://readsmith.dev/docs/ai/agent-skills
- https://readsmith.dev/docs/self-host/deploy
- https://readsmith.dev/docs/self-host/environment
- https://readsmith.dev/docs/self-host/reverse-proxy
- https://readsmith.dev/docs/self-host/security
- https://readsmith.dev/docs/self-host/upgrading
- https://readsmith.dev/docs/comparisons
- https://readsmith.dev/docs/changelog
- https://readsmith.dev/docs
- https://readsmith.dev/docs/llms.txt
