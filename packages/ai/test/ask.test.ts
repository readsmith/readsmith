import type { LanguageModel } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  ModelNotConfiguredError,
  type RetrievalStore,
  type RetrievedChunk,
  askDocs,
  createMockProvider,
  extractCitedRefs,
} from "../src/index.js";

describe("extractCitedRefs", () => {
  it("parses single, grouped, and repeated bracket citations", () => {
    expect(extractCitedRefs("a [1] b [2, 3] c [1]")).toEqual([1, 2, 3]);
    expect(extractCitedRefs("no citations here")).toEqual([]);
  });
});

describe("askDocs", () => {
  it("throws when no chat model is configured", () => {
    const provider = createMockProvider({ hasChat: false });
    expect(() =>
      askDocs(
        { provider, search: { store: emptyStore(), provider } },
        { siteId: "default", query: "hi", filters: { version: "current", locale: "en" } },
      ),
    ).toThrow(ModelNotConfiguredError);
  });

  it("calls searchDocs, cites a source, and reports the logged record", async () => {
    // A scripted chat model: step 1 calls the tool, step 2 answers citing [1].
    // The stream-part chunks widen under inference, so cast the options once (the
    // parts are correct at runtime; this only satisfies tsc).
    type MockOpts = NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>;
    let call = 0;
    const options = {
      provider: "mock",
      modelId: "mock-chat",
      doStream: async () => {
        call += 1;
        if (call === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: "tool-call",
                  toolCallId: "t1",
                  toolName: "searchDocs",
                  input: JSON.stringify({ query: "setup" }),
                },
                {
                  type: "finish",
                  finishReason: "tool-calls",
                  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
                },
              ],
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "0" },
              { type: "text-delta", id: "0", delta: "Set the API key in your env [1]." },
              { type: "text-end", id: "0" },
              {
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
              },
            ],
          }),
        };
      },
    };
    const chatModel = new MockLanguageModelV4(options as unknown as MockOpts);

    const provider = createMockProvider({
      chatModel: chatModel as unknown as LanguageModel,
      hasEmbedding: false,
    });
    const store: RetrievalStore = {
      async vectorSearch() {
        return [];
      },
      async ftsSearch() {
        return [oneHit()];
      },
    };

    const { result, completion } = askDocs(
      { provider, search: { store, provider } },
      {
        siteId: "default",
        query: "how do I set up?",
        filters: { version: "current", locale: "en" },
      },
    );

    const answer = await result.text; // drives the whole loop
    expect(answer).toContain("[1]");

    const c = await completion;
    expect(c.answer).toContain("Set the API key");
    expect(c.retrievedIds).toEqual(["s1"]);
    expect(c.citedIds).toEqual(["s1"]);
    expect(c.sources).toEqual([{ ref: 1, id: "s1", title: "Setup", url: "/setup#s" }]);
    // Usage is captured from the model's `LanguageModelUsage`; the mock surfaces
    // no token counts, so both are null. A real provider populates them (NFR-6).
    expect(c.usage).toEqual({ inputTokens: null, outputTokens: null });
  });
});

function oneHit(): RetrievedChunk {
  return {
    id: "s1",
    kind: "doc",
    pageId: "p1",
    path: "/setup",
    headerPath: ["Guide", "Setup"],
    anchor: "s",
    method: null,
    text: "Set the API key in your environment before running.",
  };
}

function emptyStore(): RetrievalStore {
  return {
    async vectorSearch() {
      return [];
    },
    async ftsSearch() {
      return [];
    },
  };
}
