import { wireSwitcher } from "./switcher.js";

/** Hydrate a Tabs island: wire its ARIA tablist and page-wide sync. */
export function enhanceTabs(mount: HTMLElement): void {
  const root = mount.querySelector<HTMLElement>(".rs-tabs") ?? mount;
  const tabs = [...root.querySelectorAll<HTMLElement>(".rs-tabs__list .rs-tabs__tab")];
  const panels = [...root.querySelectorAll<HTMLElement>(".rs-tabs__panels > .rs-tab")];
  const titles = panels.map((p) => p.getAttribute("data-rs-tab-title") ?? "");
  wireSwitcher({ container: root, tabs, panels, titles, group: root.dataset.rsGroup });
}
