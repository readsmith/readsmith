/**
 * Copy control for code blocks. Progressive enhancement: the pipeline emits a
 * static, accessible code block; this injects a copy button (into the title bar
 * if there is one, otherwise a hover-revealed float) and wires it. Copy needs
 * JS, so a no-JS reader loses nothing by the button being injected, and because
 * the float is out of flow it causes no layout shift.
 */

const REVERT_MS = 1500;

export function mountCopyButtons(root: ParentNode = document): void {
  for (const figure of root.querySelectorAll<HTMLElement>(".rs-code")) {
    if (figure.querySelector(".rs-code__copy")) continue;
    const code = figure.querySelector("code");
    if (!code) continue;

    const bar = figure.querySelector<HTMLElement>(".rs-code__bar");
    const button = document.createElement("button");
    button.type = "button";
    button.className = bar ? "rs-code__copy" : "rs-code__copy rs-code__copy--float";
    button.setAttribute("aria-label", "Copy code");
    button.textContent = "Copy";

    let timer: ReturnType<typeof setTimeout> | undefined;
    button.addEventListener("click", () => {
      void copyText(code.textContent ?? "");
      button.textContent = "Copied";
      button.classList.add("is-done");
      button.setAttribute("aria-label", "Copied");
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        button.textContent = "Copy";
        button.classList.remove("is-done");
        button.setAttribute("aria-label", "Copy code");
      }, REVERT_MS);
    });

    (bar ?? figure).appendChild(button);
  }
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    // clipboard may be unavailable (insecure context); the button still animates
  }
}
