import { llmsTxtRoute } from "@readsmith/serve";

// Static + ISR (A-8): a published deployment (pointer flip) becomes visible
// within a minute without an app rebuild; static installs serve from cache.
export const dynamic = "force-static";
export const revalidate = 60;

export const GET = llmsTxtRoute.GET;
