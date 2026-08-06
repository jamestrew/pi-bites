import { describe, expect, test } from "vitest";

import { createRtkNoHookWarningDataFilter, stripRtkNoHookWarning } from "./rtk.js";

const noHookWarning =
  "[rtk] /!\\ No hook installed — run `rtk init -g` for automatic token savings";

describe("RTK output filtering", () => {
  test("strips no-hook warning from tool output", () => {
    expect(stripRtkNoHookWarning(`stdout\n${noHookWarning}\nstderr\n`)).toBe("stdout\nstderr\n");
  });

  test("strips interleaved no-hook warning from streamed bash output", () => {
    const chunks: string[] = [];
    const onData = createRtkNoHookWarningDataFilter((data) => chunks.push(data.toString()));

    onData(Buffer.from(noHookWarning));
    onData(Buffer.from("85e8af4 commit output\n"));
    onData(Buffer.from("\n"));

    expect(chunks.join("")).toBe("85e8af4 commit output\n");
  });

  test("strips a split CRLF after an interleaved no-hook warning", () => {
    const chunks: string[] = [];
    const onData = createRtkNoHookWarningDataFilter((data) => chunks.push(data.toString()));

    onData(Buffer.from(noHookWarning));
    onData(Buffer.from("kept\n"));
    onData(Buffer.from("\r"));
    onData(Buffer.from("other\n"));
    onData(Buffer.from("\n"));
    onData(Buffer.from("later\n"));

    expect(chunks.join("")).toBe("kept\nother\nlater\n");
  });

  test("strips no-hook warning from streamed bash output", () => {
    const chunks: string[] = [];
    const onData = createRtkNoHookWarningDataFilter((data) => chunks.push(data.toString()));

    onData(Buffer.from(`${noHookWarning.slice(0, 12)}`));
    onData(Buffer.from(`${noHookWarning.slice(12)}\nkept\n`));

    expect(chunks.join("")).toBe("kept\n");
  });
});
