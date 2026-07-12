import { setupGithubCallbackRoute } from "@readsmith/serve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = setupGithubCallbackRoute.GET;
