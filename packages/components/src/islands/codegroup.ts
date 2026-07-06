import { wireSwitcher } from "./switcher.js";

/** Hydrate a CodeGroup island: wire its sample switcher and page-wide sync. */
export function enhanceCodeGroup(mount: HTMLElement): void {
  const root = mount.querySelector<HTMLElement>(".rs-codegroup") ?? mount;
  const tabs = [...root.querySelectorAll<HTMLElement>(".rs-codegroup__list .rs-codegroup__tab")];
  const panels = [...root.querySelectorAll<HTMLElement>(".rs-codegroup__panels > .rs-code")];
  const titles = tabs.map((t) => t.getAttribute("data-rs-tab-title") ?? "");
  wireSwitcher({ container: root, tabs, panels, titles, group: root.dataset.rsGroup });
}
