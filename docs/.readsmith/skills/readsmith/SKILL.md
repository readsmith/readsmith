---
name: readsmith
description: Readsmith is a Fair Source documentation platform that builds a
  docs site (navigation, search, generated OpenAPI reference, agent outputs like
  llms.txt/MCP/skill.md) from a Markdown/MDX repo, self-hosted via Docker
  Compose with Postgres/pgvector. Use when configuring docs.yaml, authoring
  pages or components (callouts, tabs, steps, cards, code groups, accordions,
  operation embeds), setting up hybrid/schema API reference pages, enabling AI
  search/Ask AI/MCP, generating or hand-authoring an Agent Skill,
  deploying/upgrading/backing up a self-hosted instance, tuning rate
  limits/CSP/reverse proxy, or debugging degraded search/Ask AI capabilities.
metadata:
  readsmith-proj: readsmith
  version: "1.0"
  readsmith-generated: 3094c72ba4d1fc419c1985b33af01d16cab53fd2c9127ad7430630389a44a273
---

# Readsmith

## Product summary
Readsmith is a Fair Source (FSL-1.1-MIT, becomes MIT two years after each release) documentation platform that compiles a repository of Markdown/MDX into a static-first docs site: zero-JS prose pages with islands only where needed, folder-based navigation by convention, a generated API reference from an OpenAPI spec, hybrid full-text/vector search, an Ask AI answerer, and machine-readable agent outputs (llms.txt, llms-full.txt, per-page /md/ Markdown, MCP server, and a generated or hand-authored Agent Skill at /skill.md). The primary docs are at https://readsmith.dev/docs. Load-bearing facts: it self-hosts as exactly two containers (the app plus Postgres with pgvector) via one Docker Compose file, and every build produces an immutable bundle so rollbacks just repoint, nothing rebuilds; without DATABASE_URL the app runs fully docs-only (pages, navigation, agent outputs all work) while search and Ask AI degrade or turn off; and AI features run on your own model keys (OpenAI, Anthropic, Google, or a gateway) resolved only from environment variables, never from config.

## When to use
- Setting up or editing docs.yaml (navigation, theming, API reference, AI, security settings)
- Authoring Markdown/MDX pages, snippets, variables, or components (callouts, tabs, steps, accordions, cards, code groups, frames, badges, updates)
- Declaring OpenAPI-backed hybrid pages (`openapi:`) or schema pages (`openapi-schema:`)
- Configuring or querying search, Ask AI, or the MCP server
- Generating (`pnpm skill:generate`) or hand-authoring a Readsmith Agent Skill
- Deploying, upgrading, backing up, or reverse-proxying a self-hosted Readsmith instance
- Debugging rate limits, CSP, degraded AI capabilities, or storage-root/content-root issues
- Choosing Readsmith versus Mintlify, GitBook, Starlight, or Fumadocs

## Quick reference

### Public site API (all public, rate limited per client IP, no auth)
| Endpoint | Method | Notes |
|---|---|---|
| /_readsmith/api/search | POST | body: query (required, 1-2000 chars), version, locale; returns hits[], degraded |
| /_readsmith/api/ask | POST | streams SSE UI message stream; same body shape as search |
| /_readsmith/api/ai/feedback | POST | body: id (required), value (integer, up/down) |
| /_readsmith/api/ai/capabilities | GET | returns search, vectorSearch, askAi booleans |
| /_readsmith/api/health | GET | returns status (ok/degraded), database (up/down/disabled); 503 if DB unreachable |
| /mcp (canonical /_readsmith/mcp) | POST (streamable HTTP) | tools: search_docs, list_endpoints, get_endpoint (latter two need API reference) |
| /llms.txt, /llms-full.txt | GET | directory and full-site Markdown export |
| /md/<page> | GET | per-page Markdown projection |
| /skill.md | GET | skill or redirect to index |
| /.well-known/skills/index.json, /.well-known/skills/<name>/SKILL.md | GET | skill discovery |
| /rss.xml | GET | fed by changelog Update entries with date frontmatter |

### Default rate limits (per client IP)
| Feature | Limit | Config key |
|---|---|---|
| Ask AI | 10/min | ai.limits.ask, READSMITH_RATE_LIMIT_ASK |
| Search | 60/min | ai.limits.search, READSMITH_RATE_LIMIT_SEARCH |
| MCP | 60/min | ai.limits.mcp, READSMITH_RATE_LIMIT_MCP |

### Key docs.yaml settings
| Key | Default | Notes |
|---|---|---|
| site.name | (required) | only mandatory key anywhere |
| content.root | . | (none) |
| content.home | unset | may escape content root, never the repo |
| apiReference.spec | unset | required to enable reference; relative to content root |
| apiReference.layout | single | single or pages |
| apiReference.path | /api-reference | (none) |
| mcp.path | /mcp | canonical endpoint always answers regardless |
| ai.chat.provider/model | unset | openai, anthropic, google, gateway |
| ai.embedding.provider/model | unset | openai, google, gateway |
| ai.search.topK | 8 | (none) |
| ai.askAi.enabled | true | (none) |
| branding | true | set false to remove "Powered by Readsmith" |

### Key environment variables
| Variable | Default | Notes |
|---|---|---|
| DATABASE_URL | unset | absent = docs-only mode |
| READSMITH_CONTENT | apps/web/content | dir holding docs.yaml/content |
| PORT | 4321 | (none) |
| STORAGE_ROOT / STORAGE_DRIVER | apps/web/.readsmith / local | compiled bundle store |
| READSMITH_STORAGE_ROOT | unset | spec blobs root; never share across sites |
| READSMITH_AI_CHAT_KEY / EMBEDDING_KEY / RERANK_KEY | unset | role overrides, checked first |
| OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / AI_GATEWAY_API_KEY | unset | provider-native, checked second |
| READSMITH_RATE_LIMIT | (none) | master on/off switch |
| READSMITH_TRUSTED_IP_HEADER | unset | only set if a trusted proxy sets it |
| READSMITH_CSP_IMG_SRC / CONNECT_SRC / FONT_SRC / FRAME_SRC / FRAME_ANCESTORS | unset | build-time only |

## Decision guidance

### API reference layout
| Option | When |
|---|---|
| single (default) | small API; one continuous page at /api-reference |
| pages | operations deserve own URLs/search/prev-next; appears as its own nav tab |

### .md vs .mdx
| Option | When |
|---|---|
| .md (plain Markdown) | docs are dual-published and also render on GitHub, or file is a shared snippet |
| .mdx | site-only page needing full component library |

### Model choice: Ask AI vs skill generation
| Option | When |
|---|---|
| A cheap model | live site Ask AI |
| Your strongest model, via --model | pnpm skill:generate; runs rarely, quality gap in extracted gotchas is large |

### Operation embed vs generated reference pages
| Option | When |
|---|---|
| `<Operation op="..."/>` | narrative page interleaving prose with a few fully specified calls |
| apiReference.layout: pages | many operations (e.g. twenty); get navigation, search, per-operation URLs for free |

### Choosing among Tabs, headings, Accordion, code group
| Option | When |
|---|---|
| Tabs | reader must choose exactly one alternative (install paths, OS, languages) |
| Headings | reader should read all content, not choose one |
| Accordion | content is optional depth expanded on demand |
| Code group | alternatives are code-only, tighter presentation |

### Navigation: auto vs explicit
| Option | When |
|---|---|
| Auto (no config) | file tree already matches desired structure |
| Explicit `navigation`/`tabs` | need curated ordering or sections; requires manual slug upkeep |

### Reverse proxy choice
| Option | When |
|---|---|
| Caddy | want automatic TLS with minimal config |
| nginx | terminating TLS yourself (certbot/CDN), prefer familiar setup |

### Where to run Readsmith
| Option | When |
|---|---|
| Self-host, one Docker Compose file | available now |
| Readsmith Cloud | soon, not yet available |

### Model provider for Search/Ask AI
| Option | When |
|---|---|
| OpenAI / Anthropic / Google | use your own keys with that provider directly |
| Gateway | route through a model gateway instead of a direct provider key |

## Workflow

1. **Deploy with Docker Compose (zero to serving)**
   1. `git clone https://github.com/readsmith/readsmith` and `cd readsmith`
   2. `cp .env.example .env`
   3. Set a real `POSTGRES_PASSWORD`, point `READSMITH_CONTENT` at your docs dir, keep `.env` out of version control
   4. `docker compose up -d --build`
   5. `curl -s https://readsmith.dev/docs/llms.txt | head -3` to confirm pages/search/agent outputs
   6. Put a reverse proxy in front before going live

2. **Configure search and Ask AI**
   1. Add `ai.chat` (provider, model) and `ai.embedding` (provider, model) to docs.yaml
   2. Set matching API keys via environment variables (role overrides first, provider-native second)
   3. Run `pnpm ai:index`
   4. Re-run `pnpm ai:index` after every deploy; it is manual, not part of automatic migrations

3. **Generate an Agent Skill from docs**
   1. `pnpm skill:generate --dry-run` to preview
   2. `pnpm skill:generate --model <strongest-available-model>`
   3. Generator extracts facts/procedures/gotchas via bounded map-reduce and verifies links against real pages
   4. Review the diff written into `.readsmith/skills/`, edit, commit
   5. Next build serves the committed skill

4. **Author an Agent Skill by hand**
   1. Create a directory under reserved `.readsmith/skills/` at content root, one per skill
   2. Add `SKILL.md` with frontmatter `name` (matching directory) and `description`
   3. Write body content; authored skills always win over generated ones

5. **Declare a hybrid API operation page**
   1. Add frontmatter `openapi: "METHOD /path"` matching a spec operation
   2. Write prose body
   3. Generated sections (authorization, parameters, request body, responses, request console) render automatically after it

6. **Declare a data-model (schema) page**
   1. Add frontmatter `openapi-schema: "SchemaName"` naming a `components.schemas` entry
   2. Write prose about the model
   3. Generated fields/required/enums/nesting render after the authored body

7. **Set up the generated API reference**
   1. Set `apiReference.spec` to the OpenAPI file path (relative to content root) in docs.yaml
   2. Optionally set `apiReference.layout` to `single` (default) or `pages`
   3. Reference builds automatically with the site

8. **Upgrade a self-hosted deployment**
   1. `git pull --tags`
   2. `docker compose up -d --build` (migrations run automatically on start, forward-only)
   3. Load the site, run one search, spot-check `/llms.txt`
   4. Check release notes before rolling back across a migration boundary

9. **Pass the real client IP through a reverse proxy**
   1. Configure the proxy to set a header only it controls (e.g. `X-Real-IP`, `CF-Connecting-IP`)
   2. Set `READSMITH_TRUSTED_IP_HEADER` to that header's name
   3. Never point it at a client-settable header on a directly exposed app

10. **Verify security posture after deploying**
    1. `curl -sI https://<host> | grep -iE "content-security-policy|x-frame-options"` and confirm both present
    2. Send eleven quick Ask AI requests; the eleventh should return 429 with `Retry-After`
    3. `curl -s https://<host> | grep -ci "api_key\|apikey"` and confirm zero

## Common gotchas
- Hidden pages (`hidden: true`) are excluded from `/llms-full.txt`, navigation, sitemap, feeds, and the AI index, but their URLs still serve
- `hidden: true` implies `noindex` unless `noindex: false` is explicitly set
- A `SKILL.md` without the generated marker is refused during regeneration unless `--force` is passed; the generator never overwrites hand-written skills and never runs during a build
- MCP is strictly read-only; agents can look things up but never change anything
- `pnpm ai:index` is manual: forgetting it after deploy leaves search/Ask AI stale even though migrations ran automatically
- `degraded: true` in search results reflects runtime provider health, not configuration; a valid embedding key can still degrade to keyword-only at request time
- The `snippet` field in search hits is a display preview only, never model grounding; use MCP `search_docs` or the `text` field for full chunk content
- A second page claiming the same OpenAPI operation or schema is a build error; the first claim wins
- A page with both `openapi` and `openapi-schema` keeps only the operation page and emits a build warning
- A schema or operation reference matching nothing in the spec renders a visible danger callout rather than silently shipping stale docs
- Untagged fenced code blocks render as plain text with worse theming; always specify a language
- Asset mounts (`assets[].from`) copy the entire directory, not just referenced files, and may escape content root but never the repo root
- The double-brace `{{var}}` syntax is Markdown-only; inside `.mdx` it parses as an expression and warns
- MDX component tags render as raw text on repos whose docs also render on GitHub; plain `.md` degrades gracefully, MDX does not
- Two sites must never share one storage root (`STORAGE_ROOT`/`READSMITH_STORAGE_ROOT`); the second build overwrites the first's compiled bundle
- CSP environment variables are read at build time only; setting them on a running container has no effect
- Setting `READSMITH_TRUSTED_IP_HEADER` to a client-settable header on a directly exposed app lets attackers forge fresh rate-limit buckets per request
- A CDN must never cache the POST endpoints under `/_readsmith/`, and must pass `/llms.txt`, `/skill.md`, `/.well-known/*` through untouched
- Publishing a content change requires rebuilding the image; there is no live content reload in a running container
- A site with no database reports `database: disabled` but overall `status: ok`; a configured-but-unreachable database returns 503, not 200
- Content files (`.md`, `.mdx`, config) are never served raw; they are build inputs only

## Verification checklist
- [ ] `docs.yaml` has `site.name` set and, if used, a valid `content.root`
- [ ] `apiReference.spec` path resolves relative to content root if an API reference is expected
- [ ] No two pages claim the same `openapi` operation or `openapi-schema` schema
- [ ] AI keys are set via environment variables only (never in `docs.yaml`), matching the configured `ai.chat.provider`/`ai.embedding.provider`
- [ ] `pnpm ai:index` has been run after the latest content deploy
- [ ] `GET /_readsmith/api/ai/capabilities` returns the expected `search`/`vectorSearch`/`askAi` booleans
- [ ] `GET /_readsmith/api/health` returns `status: ok` (or documented `degraded` cause) with correct `database` state
- [ ] `/llms.txt`, `/llms-full.txt`, and `/skill.md` serve and reflect current content (hidden pages excluded as expected)
- [ ] Reverse proxy passes `/_readsmith/*` POST requests uncached and lets `/.well-known/*` through untouched
- [ ] `READSMITH_STORAGE_ROOT`/`STORAGE_ROOT` is unique per site (no shared bundle overwrite)
- [ ] Rate limits (10/min Ask AI, 60/min search, 60/min MCP) behave as configured under load test

## Resources
- https://readsmith.dev/docs
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
- https://readsmith.dev/docs/components/overview
- https://readsmith.dev/docs/components/operation
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
- https://readsmith.dev/docs/llms.txt
