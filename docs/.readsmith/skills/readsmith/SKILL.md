---
name: readsmith
description: Readsmith is an open-source documentation platform that builds a
  Markdown/MDX repo into a docs site with navigation, search, generated OpenAPI
  reference, and agent-readable outputs (llms.txt, MCP server, Agent Skills),
  self-hosted via Docker Compose. Use when a user asks to set up, configure,
  author, self-host, upgrade, or theme a Readsmith site; wants to generate or
  hand-write an Agent Skill; needs the search/Ask AI/MCP endpoints; is writing
  docs.yaml, frontmatter, components (callouts, tabs, cards, steps, accordions),
  or an OpenAPI-driven API reference (hybrid pages, schema pages); or is
  deciding between Readsmith and Mintlify/GitBook/Starlight/Fumadocs.
metadata:
  readsmith-proj: readsmith
  version: "1.0"
  readsmith-generated: 0f0a13618375c00258f1088331541cd6f854e1d343188461a2b359ec1dc57cad
---

# Readsmith

## Product summary
Readsmith is an open-source documentation platform (docs at https://docs.readsmith.dev) that compiles a repository of Markdown/MDX into an immutable static bundle — navigation, search, a generated API reference from an OpenAPI spec, and agent-readable outputs — with zero-JS prose pages and islands only where needed. It self-hosts as two containers (the app plus Postgres with pgvector) via a single Docker Compose file, is released under the Fair Source License with no feature gates, and needs only `site.name` set in `docs.yaml`/`docs.json` to build a working site by convention. Search and Ask AI run on the operator's own model keys (OpenAI, Anthropic, Google, or a gateway) with a documented degradation ladder when a database or key is missing; agent outputs include `/llms.txt`, `/llms-full.txt`, per-page Markdown, an MCP server, and a generated `/skill.md` written into the repo for review.

## When to use
- User wants to scaffold, run, or point Readsmith at a docs repo (`quickstart`, `READSMITH_CONTENT`)
- User is authoring pages/frontmatter, snippets, variables, images/links, or Markdown vs MDX questions
- User is building or debugging a generated API reference (hybrid pages, schema pages, `apiReference` config, `<Operation>` embeds)
- User needs Readsmith's Search API, Ask AI API, MCP server, or Agent Skill generation/discovery
- User is configuring `docs.yaml` (navigation, theming, settings) or self-hosting (deploy, environment variables, reverse proxy, security, upgrading)
- User is choosing components (callouts, tabs, steps, accordions, cards, code groups, frames, inline) or comparing Readsmith to Mintlify/GitBook/Starlight/Fumadocs

## Quick reference

### Core paths
| Item | Value |
|---|---|
| Docs site | https://docs.readsmith.dev |
| Site API base URL | https://docs.readsmith.dev |
| Site API version | 0.1.0 |
| Local dev URL | http://localhost:4321 |
| llms.txt | `/llms.txt` (endpoint index appended if API reference present) |
| llms-full.txt | `/llms-full.txt` (single Markdown export, hidden pages excluded) |
| Per-page Markdown | `/md/<page-path>` |
| Skill discovery | `/skill.md`, `/.well-known/skills/index.json`, `/.well-known/skills/<name>/SKILL.md` |
| MCP canonical endpoint | `/_readsmith/mcp` (public alias default `/mcp`, set via `mcp.path`) |

### Site API endpoints (no auth; rate limited per IP)
| Endpoint | Method | Purpose | Responses |
|---|---|---|---|
| `/_readsmith/api/search` | POST | Hybrid search (full-text + vector) | 200, 400, 429, 503 |
| `/_readsmith/api/ask` | POST | Ask AI, SSE UI message stream | 200 (text/event-stream), 400, 429, 503 |
| `/_readsmith/api/ai/feedback` | POST | Thumbs signal on a logged answer | 200, 400, 503 |
| `/_readsmith/api/ai/capabilities` | GET | Degradation-ladder state | 200 |
| `/_readsmith/api/health` | GET | Liveness + DB reachability | 200, 503 |

### Search / Ask AI request body (both endpoints)
| Field | Type | Required | Notes |
|---|---|---|---|
| query | string | yes | min length 1, max length 2000 |
| version | string | no | defaults to current |
| locale | string | no | defaults to `en` |

### SearchHit fields
| Field | Type | Notes |
|---|---|---|
| id, title, snippet, url, headerPath[], score | required | snippet is display-only preview |
| kind | required | `"doc"` \| `"endpoint"` |
| text | optional | full chunk text, if requested |
| anchor, method, path | string\|null, required | |

### Feedback / Capabilities / Health response fields
| Endpoint | Field | Type |
|---|---|---|
| feedback 200 | ok | boolean |
| capabilities 200 | search, vectorSearch, askAi | boolean |
| health 200/503 | status | `"ok"` \| `"degraded"` |
| health 200/503 | database | `"up"` \| `"down"` \| `"disabled"` |

### Default rate limits (per client IP)
| Feature | Default |
|---|---|
| Ask AI | 10 req/min |
| Search | 60 req/min |
| MCP | 60 req/min |

### Key docs.yaml settings
| Key | Default |
|---|---|
| site.name | required, no default |
| site.url | unset |
| content.root | `.` |
| content.include | `**/*.md`, `**/*.mdx` |
| appearance.default | `system` |
| apiReference.spec | unset (required to enable) |
| apiReference.path | `/api-reference` |
| apiReference.layout | `single` (or `pages`) |
| branding | `true` |
| mcp.path | `/mcp` |
| ai.search.rrfK / topK | 60 / 8 |
| ai.askAi.enabled / maxSteps / maxOutputTokens / timeoutMs | true / 4 / 1024 / 30000 |
| ai.limits.ask / search / mcp | 10/min / 60/min / 60/min |

### Key environment variables
| Variable | Default |
|---|---|
| READSMITH_CONTENT | `apps/web/content` |
| DATABASE_URL | unset |
| PORT | `4321` |
| STORAGE_ROOT / STORAGE_DRIVER | `apps/web/.readsmith` / `local` |
| READSMITH_STORAGE_ROOT | unset (must be unique per site) |
| CACHE_DRIVER | `memory` |
| READSMITH_LOG_LEVEL | `info` |
| READSMITH_WORKER_CONCURRENCY | `2` |
| AI role-override keys | `READSMITH_AI_CHAT_KEY`, `READSMITH_AI_EMBEDDING_KEY`, `READSMITH_AI_RERANK_KEY` (checked before provider-native vars) |
| Provider-native keys | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `AI_GATEWAY_API_KEY` |
| READSMITH_RATE_LIMIT* | master switch + per-feature overrides, win over config |
| READSMITH_TRUSTED_IP_HEADER | unset (uses socket address) |
| READSMITH_CSP_* | build-time only |

## Decision guidance

### apiReference.layout
| Option | When |
|---|---|
| `single` (default) | Small API; one continuous page at `/api-reference` |
| `pages` | Operations need own URLs/search results; joins top-level tab row |

### Config file format
| Option | When |
|---|---|
| `docs.yaml`/`docs.yml` | Default, native shape |
| `docs.json` | Migrating from Mintlify-compatible setup |

### .md vs .mdx
| Option | When |
|---|---|
| `.md` | Dual-published/shared file (also renders on GitHub); MDX tags degrade to raw text outside Readsmith |
| `.mdx` | Site-only page needing full component library |

### Navigation
| Option | When |
|---|---|
| Auto-navigation (no config) | Start here; file tree already matches mental model |
| Explicit `navigation`/`tabs` config | Only once auto sidebar stops matching intent |

### Local run
| Option | When |
|---|---|
| Docker + Compose plugin | Standard path; full stack incl. search/Ask AI |
| Node.js 22+ / pnpm | Preview without containers; runs docs-only, no DB |

### Callout severity
| Severity | When |
|---|---|
| Note | Skippable enriching detail |
| Info | Context needed to proceed correctly |
| Tip | Best practice/recommendation |
| Warning | Reversible harm/surprise/data risk |
| Danger | Irreversible or security-relevant harm |
| Check | Confirmation at end of procedure |

### Tabs vs alternatives
| Option | When |
|---|---|
| Tabs | Reader chooses exactly one alternative |
| Headings | Reader should read all content |
| Accordion | Optional, skippable depth |
| Code group | Alternatives are code-only |

### Operation embed vs generated pages
| Option | When |
|---|---|
| `<Operation op="...">` | Narrative page interleaving prose with 3–4 fully specified calls |
| `apiReference.layout: pages` | Many operations; free navigation/search/URLs instead of stacked embeds |

### Steps vs plain list
| Option | When |
|---|---|
| `<Steps>` | Order carries real sequential meaning |
| Plain list | Items are independent options, not a required sequence |

## Workflow

1. **Quickstart with Docker Compose**
   1. `git clone https://github.com/readsmith/readsmith && cd readsmith`
   2. `cp .env.example .env` and set `POSTGRES_PASSWORD`
   3. `docker compose up`
   4. Visit `http://localhost:4321`
   5. Point at your own docs: set `READSMITH_CONTENT` to your content directory and restart

2. **Write your first page**
   1. Create `index.md` in the content directory with a heading and content
   2. Rebuild or let the dev server pick it up
   3. Page is live, in navigation, in `/llms.txt`, and indexed for search

3. **Set up the generated API reference**
   1. Add `apiReference.spec: <path>` in `docs.yaml`, relative to content root
   2. Optionally set `apiReference.layout` to `single` (default) or `pages`
   3. For a hybrid narrative page: frontmatter `openapi: "METHOD /path"` (or `"file.json POST /path"`), write prose; generated sections render after it
   4. For a data-model page: frontmatter `openapi-schema: "SchemaName"` (or `"openapi.json Pet"`), write prose; generated fields render after it

4. **Generate or author an Agent Skill**
   1. To generate: run `pnpm skill:generate --dry-run` to preview, or `pnpm skill:generate --model <model>` for a stronger model
   2. Generator reads the built site, extracts facts/procedures/gotchas, verifies links, writes into `.readsmith/skills/`, and prints cost
   3. Review the diff, edit as needed, commit
   4. To hand-write instead: create `.readsmith/skills/<name>/SKILL.md` with frontmatter `name` (matching dir) and `description`; hand-written skills always win over generated ones

5. **Deploy and verify a self-hosted instance**
   1. `git clone ... && cd readsmith && cp .env.example .env`
   2. Set `POSTGRES_PASSWORD`, point `READSMITH_CONTENT`
   3. `docker compose up -d --build`
   4. `curl -s http://localhost:4321/llms.txt | head -3` to verify
   5. Put a reverse proxy (e.g. Caddy) in front; set `READSMITH_TRUSTED_IP_HEADER` only to a header your proxy controls
   6. `curl -sI https://<domain> | grep -iE "content-security-policy|x-frame-options"` to confirm both headers present
   7. Send 11 quick Ask AI requests and confirm the 11th returns 429 with `Retry-After`

6. **Upgrade a deployment**
   1. `git pull --tags`
   2. `docker compose up -d --build` (migrations run automatically)
   3. Load the site, run one search, spot-check `/llms.txt`
   4. Back up DB (`pg_dump`), `storage-data` volume, and content repo beforehand

## Common gotchas
- Generating a skill refuses to overwrite a hand-written `SKILL.md` lacking the generated marker unless `--force` is passed
- Skill generation never runs during a build and is a no-op if content is unchanged since last generation
- If a docs page itself claims `/mcp`, the MCP endpoint is still reachable only at `/_readsmith/mcp` or the configured `mcp.path` alias; MCP is strictly read-only
- After deploys, `pnpm ai:index` must be run manually — it is not automatic like migrations
- `degraded:true` in search reflects runtime provider health, not configuration — a valid key can still degrade under load
- The `snippet` field is a display preview only, never used for grounding; use MCP `search_docs` for full text
- Two pages claiming the same OpenAPI operation, or two schema pages claiming the same schema, is a build error (first claim wins)
- A `openapi-schema` name matching nothing renders a visible danger callout instead of failing silently; same for `<Operation op="...">` matching nothing
- If a page has both `openapi` and `openapi-schema` frontmatter keys, `openapi` wins and a build warning is emitted
- Untagged (no language) code blocks render as plain text in both themes
- An asset mount (`assets: - from/to`) copies the entire directory, not just referenced files — can leak scripts/private data
- MDX component tags render as raw text on GitHub; dual-published shared files should stay `.md`
- `{{version}}` syntax is Markdown-only; used inside `.mdx` it parses as an expression and warns
- `hidden: true` implies `noindex` unless `noindex: false` is explicitly set
- `{{variable}}` inside code spans/fences is never interpolated; unknown variable references warn rather than fail
- Sharing one `READSMITH_STORAGE_ROOT` between two sites makes the second overwrite the first's compiled bundle
- A snippet cycle or excessive nesting is reported as a build diagnostic, not an infinite loop
- Forgetting a blank line between `<CodeGroup>` tags and fenced blocks breaks the grouping
- Skipping `ratio` on a `Frame` forfeits layout-shift protection
- Tooltips must never carry essential content — hidden until hover/focus
- A navigation slug matching no page, or a page missing from an explicit `navigation` list, is only caught at build time (and the page stays reachable by URL either way)
- `content.exclude` merges with default ignores (`node_modules`, `.git`, `snippets/`) — never replaces them
- CSP env vars (`READSMITH_CSP_*`) are read at build time only, not on a running container; malformed CSP tokens are dropped, not trusted
- Trusting a client-settable header (e.g. raw `X-Forwarded-For`) for `READSMITH_TRUSTED_IP_HEADER` defeats rate limiting by giving every request its own bucket
- Behind a CDN, exclude `POST` requests under `/_readsmith/` from caching; let `/llms.txt`, `/skill.md`, `/.well-known/*` through untouched
- Docs pages are baked into the image at build time; a content change requires `docker compose up -d --build` — nothing compiles at request time
- Database migrations are forward-only; check release notes before rolling back across a migration boundary
- A docs-only site (no `DATABASE_URL`) reports database status `"disabled"` and still reports healthy; 503 from `/health` means the DB is configured but unreachable, a distinct case

## Verification checklist
- [ ] `docs.yaml`/`docs.json` sets `site.name` and builds without missing-variable or broken-link/anchor warnings
- [ ] `curl https://<site>/llms.txt` (or local `http://localhost:4321/llms.txt`) returns the expected directory
- [ ] If an API reference is configured, `apiReference.spec` resolves and `/api-reference` (or per-operation pages) render without danger-callout placeholders for missing operations/schemas
- [ ] `GET /_readsmith/api/health` returns `status: "ok"` and the expected `database` value for the deployment's configuration
- [ ] `GET /_readsmith/api/ai/capabilities` matches expectations (search/vectorSearch/askAi on only where keys and DB are configured)
- [ ] Rate limiting confirmed: an 11th rapid Ask AI request returns 429 with `Retry-After`
- [ ] Security headers present: `content-security-policy` and `x-frame-options` on responses
- [ ] No API keys leak into served output (`grep -ci "api_key\|apikey"` on the response is zero)
- [ ] Generated or hand-written `SKILL.md` reviewed/committed and `name` matches its directory
- [ ] `READSMITH_STORAGE_ROOT` is unique per deployment, not shared across sites

## Resources
- https://docs.readsmith.dev/what-is-readsmith
- https://docs.readsmith.dev/quickstart
- https://docs.readsmith.dev/configuration/overview
- https://docs.readsmith.dev/configuration/settings-reference
- https://docs.readsmith.dev/configuration/navigation
- https://docs.readsmith.dev/configuration/theming
- https://docs.readsmith.dev/authoring/pages
- https://docs.readsmith.dev/authoring/markdown
- https://docs.readsmith.dev/authoring/snippets-and-variables
- https://docs.readsmith.dev/authoring/images-and-links
- https://docs.readsmith.dev/authoring/code-blocks
- https://docs.readsmith.dev/components/overview
- https://docs.readsmith.dev/components/callouts
- https://docs.readsmith.dev/components/cards
- https://docs.readsmith.dev/components/tabs
- https://docs.readsmith.dev/components/steps
- https://docs.readsmith.dev/components/accordions
- https://docs.readsmith.dev/components/code-groups
- https://docs.readsmith.dev/components/frames
- https://docs.readsmith.dev/components/inline
- https://docs.readsmith.dev/components/operation
- https://docs.readsmith.dev/components/updates
- https://docs.readsmith.dev/api-reference-guide/setup
- https://docs.readsmith.dev/api-reference-guide/hybrid-pages
- https://docs.readsmith.dev/api-reference-guide/schema-pages
- https://docs.readsmith.dev/api-reference
- https://docs.readsmith.dev/api-reference/askdocs
- https://docs.readsmith.dev/api-reference/sendfeedback
- https://docs.readsmith.dev/api-reference/getcapabilities
- https://docs.readsmith.dev/api-reference/gethealth
- https://docs.readsmith.dev/ai/agent-outputs
- https://docs.readsmith.dev/ai/agent-skills
- https://docs.readsmith.dev/ai/mcp
- https://docs.readsmith.dev/ai/search-and-ask
- https://docs.readsmith.dev/ai/search-api
- https://docs.readsmith.dev/self-host/deploy
- https://docs.readsmith.dev/self-host/environment
- https://docs.readsmith.dev/self-host/reverse-proxy
- https://docs.readsmith.dev/self-host/security
- https://docs.readsmith.dev/self-host/upgrading
- https://docs.readsmith.dev/comparisons
- https://docs.readsmith.dev/changelog
- https://docs.readsmith.dev
- Directory of all docs for agents: https://docs.readsmith.dev/llms.txt
