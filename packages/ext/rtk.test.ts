import { describe, expect, test } from "vitest";

import { createRtkNoHookWarningDataFilter, stripRtkNoHookWarning } from "./rtk.js";

const noHookWarning =
  "[rtk] /!\\ No hook installed — run `rtk init -g` for automatic token savings";

describe("RTK output filtering", () => {
  test("strips no-hook warning from tool output", () => {
    expect(stripRtkNoHookWarning(`stdout\n${noHookWarning}\nstderr\n`)).toBe("stdout\nstderr\n");
  });

  test("strips no-hook warning from streamed bash output", () => {
    const chunks: string[] = [];
    const onData = createRtkNoHookWarningDataFilter((data) => chunks.push(data.toString()));

    onData(Buffer.from(`${noHookWarning.slice(0, 12)}`));
    onData(Buffer.from(`${noHookWarning.slice(12)}\nkept\n`));

    expect(chunks.join("")).toBe("kept\n");
  });
});
