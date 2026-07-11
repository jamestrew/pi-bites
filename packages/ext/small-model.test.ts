import { describe, expect, test } from "vitest";
import { DEFAULT_SMALL_MODEL, getSmallModel } from "./small-model.js";

const currentModel = { provider: "anthropic", id: "claude-sonnet" };
const defaultModel = { provider: "github-copilot", id: "claude-haiku-4.5" };

function context(models: unknown[], current: unknown = currentModel) {
  return {
    model: current,
    modelRegistry: {
      getAll: () => models,
      getAvailable: () => models,
      find: (provider: string, id: string) =>
        models.find((model: any) => model.provider === provider && model.id === id),
    },
  } as any;
}

describe("getSmallModel", () => {
  test("uses the cheap default with low thinking", () => {
    expect(getSmallModel({}, context([defaultModel]))).toEqual({
      model: defaultModel,
      thinking: "low",
    });
    expect(DEFAULT_SMALL_MODEL).toBe("github-copilot/claude-haiku-4.5");
  });

  test("resolves config and falls back to the current model when unavailable", () => {
    const configured = { provider: "anthropic", id: "claude-haiku", name: "Haiku" };
    expect(
      getSmallModel(
        { smallModel: { model: "anthropic/claude-haiku", thinking: "minimal" } },
        context([configured]),
      ),
    ).toEqual({ model: configured, thinking: "minimal" });

    expect(getSmallModel({}, context([])).model).toBe(currentModel);
  });
});
