import { describe, expect, it } from "vitest";
import { formatSessionTokens } from "../ui/agent-format.js";

describe("formatSessionTokens", () => {
  const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` } as any;

  it("colors context percentage thresholds", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("1.2k token");
    expect(formatSessionTokens(1234, 50, theme)).toBe("1.2k token (<dim>50%</dim>)");
    expect(formatSessionTokens(1234, 70, theme)).toBe("1.2k token (<warning>70%</warning>)");
    expect(formatSessionTokens(1234, 84, theme)).toBe("1.2k token (<warning>84%</warning>)");
    expect(formatSessionTokens(1234, 85, theme)).toBe("1.2k token (<error>85%</error>)");
    expect(formatSessionTokens(1234, 99, theme)).toBe("1.2k token (<error>99%</error>)");
  });

  it("adds compaction count annotations", () => {
    expect(formatSessionTokens(1234, null, theme, 1)).toBe("1.2k token (<dim>⇊1</dim>)");
    expect(formatSessionTokens(1234, null, theme, 3)).toBe("1.2k token (<dim>⇊3</dim>)");
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe(
      "1.2k token (<dim>45%</dim> · <dim>⇊2</dim>)",
    );
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe(
      "1.2k token (<error>88%</error> · <dim>⇊4</dim>)",
    );
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe("1.2k token (<dim>45%</dim>)");
  });
});
