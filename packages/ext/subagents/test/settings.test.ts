import { describe, expect, it } from "vitest";
import { applySettings } from "../settings.js";

describe("subagent settings application", () => {
  it("resets all omitted settings instead of retaining values from a previous load", () => {
    let defaults: unknown;
    let maxDepth: number | undefined;
    let maxConcurrent: number | undefined;
    let fleetView: boolean | undefined;
    const appliers = {
      setModelDefaults: (value: unknown) => {
        defaults = value;
      },
      setMaxDepth: (value: number | undefined) => {
        maxDepth = value;
      },
      setMaxConcurrent: (value: number | undefined) => {
        maxConcurrent = value;
      },
      setFleetView: (value: boolean) => {
        fleetView = value;
      },
    };
    applySettings(
      {
        defaultModel: "provider/model",
        defaultReasoningEffort: "off",
        maxDepth: 0,
        maxConcurrent: 1,
        fleetView: false,
      },
      appliers,
    );
    expect([defaults, maxDepth, maxConcurrent, fleetView]).toEqual([
      { defaultModel: "provider/model", defaultReasoningEffort: "off" },
      0,
      1,
      false,
    ]);
    applySettings({}, appliers);
    expect([defaults, maxDepth, maxConcurrent, fleetView]).toEqual([
      { defaultModel: undefined, defaultReasoningEffort: undefined },
      undefined,
      undefined,
      true,
    ]);
  });
});
