import { ICONS, esc } from "./util.js";

/**
 * The per-page contextual menu ("page actions"): copy/view the page as Markdown,
 * open it in an AI chat with the page preloaded, or connect an agent to this
 * site's MCP server. Data-driven from `contextual.options` (docs.json-compatible)
 * so a site can trim, reorder, or extend the menu; unset falls back to the full
 * default set.
 *
 * Every Readsmith site is already an MCP server, so the "connect" group offers
 * one-click install into Cursor and VS Code plus the raw endpoint URL. Those
 * items only render when the host reports MCP is available.
 */
export type ContextualOption =
  | "copy"
  | "view"
  | "chatgpt"
  | "claude"
  | "perplexity"
  | "cursor"
  | "vscode"
  | "mcp";

/** The full menu when a site does not configure `contextual.options`. */
export const DEFAULT_CONTEXTUAL_OPTIONS: ContextualOption[] = [
  "copy",
  "view",
  "chatgpt",
  "claude",
  "perplexity",
  "cursor",
  "vscode",
  "mcp",
];

const AI_OPTIONS = new Set<ContextualOption>(["chatgpt", "claude", "perplexity"]);
const MCP_OPTIONS = new Set<ContextualOption>(["cursor", "vscode", "mcp"]);

export interface ContextMenuInputs {
  /** The page's `/md` projection URL (carries any subpath prefix). */
  mdUrl: string;
  /** URL-encoded prompt that preloads the AI chat with this page. */
  prompt: string;
  /** Absolute MCP endpoint URL, present only when the site serves MCP. */
  mcpUrl?: string;
  /** Server name used in the Cursor/VS Code install links. */
  serverName: string;
  /** The resolved option list; order is honored within each group. */
  options: ContextualOption[];
}

/** One AI chat destination that preloads the page as a prompt. */
function aiLink(option: ContextualOption, prompt: string): string {
  const provider: Record<string, { label: string; url: string }> = {
    chatgpt: { label: "Open in ChatGPT", url: `https://chatgpt.com/?q=${prompt}` },
    claude: { label: "Open in Claude", url: `https://claude.ai/new?q=${prompt}` },
    perplexity: {
      label: "Open in Perplexity",
      url: `https://www.perplexity.ai/search?q=${prompt}`,
    },
  };
  const p = provider[option];
  if (!p) return "";
  return menuLink(p.url, p.label, ICONS.ai);
}

/** Base64 of a UTF-8 string, portable across Node and the browser (btoa is ASCII-only). */
function base64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** The Cursor one-click MCP install deep link (config is base64-encoded JSON). */
export function cursorInstallUrl(serverName: string, mcpUrl: string): string {
  const config = base64Utf8(JSON.stringify({ url: mcpUrl }));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(
    serverName,
  )}&config=${config}`;
}

/** The VS Code one-click MCP install deep link (URL-encoded JSON, type "http"). */
export function vscodeInstallUrl(serverName: string, mcpUrl: string): string {
  const config = JSON.stringify({ name: serverName, type: "http", url: mcpUrl });
  return `vscode:mcp/install?${encodeURIComponent(config)}`;
}

/**
 * A menu link. Web destinations open in a new tab; a custom-scheme link
 * (cursor://, vscode:) navigates in place so the OS handler fires without
 * leaving a dangling blank tab.
 */
function menuLink(href: string, label: string, icon: string, newTab = true): string {
  const target = newTab ? ' target="_blank" rel="noopener"' : "";
  return `<a role="menuitem" href="${esc(href)}"${target}>${icon}${esc(label)}</a>`;
}

/**
 * Render the page-actions menu body from the resolved options. Groups are
 * separated by a rule: page (copy/view), ask-AI (providers), connect (MCP). The
 * "Copy page URL" action is always present as the first item.
 */
export function renderContextMenu(inputs: ContextMenuInputs): string {
  const { mdUrl, prompt, mcpUrl, serverName, options } = inputs;
  const page: string[] = [
    `<button role="menuitem" data-rs-copy-url>${ICONS.link}Copy page URL</button>`,
  ];
  const ai: string[] = [];
  const connect: string[] = [];

  for (const option of options) {
    if (option === "copy") {
      page.push(
        `<button role="menuitem" data-rs-copy-md data-rs-md-url="${esc(mdUrl)}">${ICONS.markdown}Copy as Markdown</button>`,
      );
    } else if (option === "view") {
      page.push(menuLink(mdUrl, "View as Markdown", ICONS.markdown));
    } else if (AI_OPTIONS.has(option)) {
      ai.push(aiLink(option, prompt));
    } else if (MCP_OPTIONS.has(option) && mcpUrl) {
      if (option === "cursor") {
        connect.push(
          menuLink(cursorInstallUrl(serverName, mcpUrl), "Add to Cursor", ICONS.install, false),
        );
      } else if (option === "vscode") {
        connect.push(
          menuLink(vscodeInstallUrl(serverName, mcpUrl), "Add to VS Code", ICONS.install, false),
        );
      } else {
        connect.push(
          `<button role="menuitem" data-rs-copy-mcp data-rs-mcp-url="${esc(mcpUrl)}">${ICONS.server}Copy MCP URL</button>`,
        );
      }
    }
  }

  const sep = '<div class="rs-menu__sep"></div>';
  return [page, ai, connect]
    .filter((group) => group.length > 0)
    .map((group) => group.join(""))
    .join(sep);
}
