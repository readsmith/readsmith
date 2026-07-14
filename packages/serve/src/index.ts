/**
 * The serving shell's server logic, extracted so any Next app (the OSS web app,
 * the hosted multi-tenant server) can compose the same behavior. Two kinds of
 * exports live here:
 *
 * - Services and loaders (site resolution, DB/AI/git singletons, boot): import
 *   them directly.
 * - Route modules (`*Route` namespaces): each mirrors one Next route file. The
 *   app's route file re-exports the handlers and declares its own segment
 *   config literally (Next reads `dynamic` / `revalidate` / `runtime` by static
 *   analysis, so those cannot live behind a re-export).
 *
 * This package is server-only and ships no JSX; page/layout components stay in
 * the app. It must be listed in `serverExternalPackages` so Next leaves it (and
 * its singletons) to the Node resolver instead of bundling per module graph.
 */
export * from "./site.js";
export * from "./db.js";
export * from "./ai.js";
export * from "./analytics.js";
export * from "./exec.js";
export * from "./boot.js";
export * from "./git.js";
export * from "./indexing.js";
export * from "./rate-limit.js";
export * from "./render-page.js";
export * from "./setup.js";
export * from "./skills.js";
export * from "./text-routes.js";

export * as apiRoute from "./routes/api.js";
export * as faviconRoute from "./routes/favicon.js";
export * as llmsTxtRoute from "./routes/llms-txt.js";
export * as llmsFullTxtRoute from "./routes/llms-full-txt.js";
export * as mcpRoute from "./routes/mcp.js";
export * as mdRoute from "./routes/md.js";
export * as robotsTxtRoute from "./routes/robots-txt.js";
export * as rssXmlRoute from "./routes/rss-xml.js";
export * as setupGithubRoute from "./routes/setup-github.js";
export * as setupGithubCallbackRoute from "./routes/setup-github-callback.js";
export * as sitemapXmlRoute from "./routes/sitemap-xml.js";
export * as skillMdRoute from "./routes/skill-md.js";
export * as skillsRedirectRoute from "./routes/skills-redirect.js";
export * as skillsIndexRoute from "./routes/skills-index.js";
export * as skillsFileRoute from "./routes/skills-file.js";
