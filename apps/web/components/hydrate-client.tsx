"use client";

import { hydrate } from "@readsmith/components";
import { useEffect } from "react";

/**
 * Triggers island hydration on the client. The page HTML is prebuilt (injected
 * server-side), so React does not own the interactive parts; this enhances the
 * static DOM once. Guarded so React StrictMode's double-invoke does not attach
 * duplicate listeners.
 */
export function HydrateClient() {
  useEffect(() => {
    if (document.documentElement.dataset.rsReady === "1") return;
    document.documentElement.dataset.rsReady = "1";
    hydrate();
  }, []);
  return null;
}
