/**
 * API-reference enhancers: a scroll-spy that highlights the nav entry for the
 * operation currently in view (handling the last section, which can never scroll
 * to the top of a page), controlled smooth-scroll on nav clicks (so the native
 * fragment jump does not fight a section pinned near the bottom), and the
 * request-URL copy buttons. Only engages on a reference page.
 */
export function initReference(root: ParentNode = document): void {
  const container = root.querySelector<HTMLElement>("[data-rs-apiref]");
  if (!container) return;

  const links = new Map<string, HTMLElement>();
  for (const link of container.querySelectorAll<HTMLElement>(".rs-apinav__link")) {
    const id = decodeURIComponent((link.getAttribute("href") ?? "").replace(/^#/, ""));
    if (id) links.set(id, link);
  }
  const sections = [...container.querySelectorAll<HTMLElement>(".rs-op[id]")];

  if (sections.length > 0) {
    const setActive = (id: string): void => {
      for (const [key, link] of links) link.classList.toggle("is-active", key === id);
    };
    const chrome =
      Number.parseInt(
        getComputedStyle(document.documentElement).getPropertyValue("--rs-chrome-height"),
        10,
      ) || 60;
    const offset = chrome + 20;

    const first = sections[0];
    const last = sections[sections.length - 1];

    const spy = (): void => {
      // At the bottom of the page the last section can never reach the top band,
      // so activate it explicitly.
      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      if (atBottom && last) {
        setActive(last.id);
        return;
      }
      // Otherwise: the last section whose top has crossed the active line.
      let currentId = first ? first.id : "";
      for (const section of sections) {
        if (section.getBoundingClientRect().top <= offset + 20) currentId = section.id;
      }
      if (currentId) setActive(currentId);
    };
    addEventListener("scroll", spy, { passive: true });
    addEventListener("resize", spy, { passive: true });
    spy();

    // Take over nav clicks: one clamped smooth scroll, update the hash without a
    // second native jump, and mark the target active immediately.
    for (const [id, link] of links) {
      link.addEventListener("click", (event) => {
        const target = document.getElementById(id);
        if (!target) return;
        event.preventDefault();
        const top = target.getBoundingClientRect().top + window.scrollY - offset;
        window.scrollTo({ top, behavior: "smooth" });
        history.replaceState(null, "", `#${id}`);
        setActive(id);
      });
    }
  }

  initPathCopy(container);
}

function initPathCopy(container: HTMLElement): void {
  for (const button of container.querySelectorAll<HTMLElement>("[data-rs-copy-text]")) {
    button.addEventListener("click", () => {
      const text = button.dataset.rsCopyText ?? "";
      void navigator.clipboard?.writeText(text).catch(() => undefined);
      button.classList.add("is-done");
      window.setTimeout(() => button.classList.remove("is-done"), 1000);
    });
  }
}
