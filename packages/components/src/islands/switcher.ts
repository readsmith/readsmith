/**
 * Shared tab-switching behaviour for Tabs and CodeGroup. Wires an ARIA tablist:
 * roving tabindex, arrow/home/end keys, click selection, and page-wide sync by
 * group (choose a value in one switcher and every switcher in the same group
 * follows). The selection persists per group so a reload and a deep link restore
 * it. The markup is server-rendered; this only enhances it.
 */

let uidCounter = 0;
const groupValue = new Map<string, string>();
const groupMembers = new Map<string, Array<(title: string) => void>>();

export interface SwitcherParts {
  container: HTMLElement;
  tabs: HTMLElement[];
  panels: HTMLElement[];
  titles: string[];
  group?: string;
}

export function wireSwitcher({ container, tabs, panels, titles, group }: SwitcherParts): void {
  if (tabs.length === 0) return;
  const uid = `rs-switch-${uidCounter++}`;

  tabs.forEach((tabEl, i) => {
    tabEl.id = `${uid}-tab-${i}`;
    const panel = panels[i];
    if (panel) {
      panel.id = `${uid}-panel-${i}`;
      tabEl.setAttribute("aria-controls", panel.id);
      panel.setAttribute("aria-labelledby", tabEl.id);
    }
    tabEl.addEventListener("click", () => select(i, true));
  });

  container.addEventListener("keydown", (event) => {
    const i = tabs.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next !== null) {
      event.preventDefault();
      select(next, true);
    }
  });

  function select(index: number, focus: boolean, broadcast = true): void {
    tabs.forEach((tabEl, j) => {
      const on = j === index;
      tabEl.setAttribute("aria-selected", on ? "true" : "false");
      tabEl.tabIndex = on ? 0 : -1;
      const panel = panels[j];
      if (panel) panel.hidden = !on;
    });
    if (focus) tabs[index]?.focus();
    if (broadcast && group) {
      const title = titles[index];
      if (title !== undefined) {
        groupValue.set(group, title);
        persist(group, title);
        for (const member of groupMembers.get(group) ?? []) member(title);
      }
    }
  }

  function selectByTitle(title: string): void {
    const index = titles.indexOf(title);
    if (index >= 0) select(index, false, false);
  }

  if (group) {
    let members = groupMembers.get(group);
    if (!members) {
      members = [];
      groupMembers.set(group, members);
    }
    members.push(selectByTitle);

    const restored = groupValue.get(group) ?? read(group);
    if (restored && titles.includes(restored)) selectByTitle(restored);
  }
}

function persist(group: string, title: string): void {
  try {
    localStorage.setItem(`rs-switch:${group}`, title);
  } catch {
    // storage may be unavailable; sync still works within the page session
  }
}

function read(group: string): string | null {
  try {
    return localStorage.getItem(`rs-switch:${group}`);
  } catch {
    return null;
  }
}
