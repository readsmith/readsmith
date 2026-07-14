/**
 * Persisted dismissal for `<Banner dismissible>`. Static banners need no JS;
 * this enhancer only touches banners the render marked `data-dismissible`. It
 * runs from `hydrate()` (like the copy buttons), not the island manifest, so a
 * non-dismissible banner ships zero JavaScript and no manifest entry.
 *
 * A banner's dismissal is keyed by a content hash (`data-banner-key`), so the
 * same announcement stays hidden across pages and a new one re-appears. Storage
 * access is guarded: a reader with storage blocked can still dismiss for the
 * session, they just see it again next visit.
 */
const STORE_PREFIX = "rs-banner-dismissed:";

function isDismissed(key: string): boolean {
  if (!key) return false;
  try {
    return localStorage.getItem(STORE_PREFIX + key) === "1";
  } catch {
    return false;
  }
}

function rememberDismissed(key: string): void {
  if (!key) return;
  try {
    localStorage.setItem(STORE_PREFIX + key, "1");
  } catch {
    // storage unavailable (private mode, blocked cookies): dismiss for the session only.
  }
}

export function initBanners(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>(".rs-banner[data-dismissible]")) {
    if (el.dataset.rsBannerInit === "true") continue;
    el.dataset.rsBannerInit = "true";

    const key = el.dataset.bannerKey ?? "";
    if (isDismissed(key)) {
      el.hidden = true;
      continue;
    }

    const button = el.querySelector<HTMLButtonElement>(".rs-banner__dismiss");
    button?.addEventListener("click", () => {
      el.hidden = true;
      rememberDismissed(key);
    });
  }
}
