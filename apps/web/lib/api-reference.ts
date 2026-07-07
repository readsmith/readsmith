// The API reference is precompiled into the content bundle (see
// scripts/build-content.mjs) and read alongside the site. This re-export keeps
// the import site stable for the reference page and the SEO routes.
export { getApiReference, type ApiReference } from "./site";
