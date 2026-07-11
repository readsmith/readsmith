<h1 align="center">Readsmith</h1>

<p align="center"><strong>Beautiful, self-hostable, AI-native documentation.</strong></p>

<p align="center">
  Point Readsmith at a repository of Markdown/MDX and get a fast, gorgeous,
  agent-ready docs site with built-in search, an Ask-AI assistant, and a
  premium reading experience. Self-host it in minutes with Docker Compose.
</p>

---

## Why Readsmith

- **A reading experience worth the name.** Deliberate typography, dark and light themes, zero layout shift, accessible by default.
- **AI-native, for free.** Semantic search, a cited Ask-AI assistant, and agent-readiness (`llms.txt`, `skill.md`, Markdown serving, an MCP server) out of the box, not gated add-ons.
- **Docs-as-code.** Connect a Git repo and every push builds and publishes. No config required: a folder of `.mdx` just works.
- **A beautiful API reference.** Render OpenAPI as a first-class, great-looking reference with multi-language code samples.
- **Yours to run.** Self-hostable with Docker Compose and Postgres. No external services required.

## Quickstart

```bash
git clone https://github.com/readsmith/readsmith && cd readsmith
cp .env.example .env   # set POSTGRES_PASSWORD; everything else has a working default
docker compose up
```

Then visit `http://localhost:4321`. You are looking at the bundled sample
content, served exactly the way your docs will be. The full guide lives at
[readsmith.dev/docs](https://readsmith.dev/docs).

To develop on Readsmith itself:

```bash
pnpm install
pnpm dev
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Contributions are welcome under the
Developer Certificate of Origin: sign your commits with `git commit -s`.

## License

Readsmith is [Fair Source](https://fair.io) software under the
[Functional Source License, v1.1, MIT Future License](./LICENSE.md) (FSL-1.1-MIT).

In plain words:

- **You can** self-host Readsmith for your own docs (personal, internal, or
  public), modify it, and redistribute it. Every feature is included; nothing
  is gated behind the license.
- **You cannot** offer Readsmith itself to others as a competing commercial
  product or service (for example, a hosted docs platform built on this code).
- **Each release becomes MIT automatically two years after it ships.** The
  future of the code is guaranteed open source, on a public clock.
