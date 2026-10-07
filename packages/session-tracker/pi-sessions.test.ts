import { execFileSync, spawnSync } from "node:child_process";
import { beforeEach, expect, test, vi } from "vitest";
import { parseArgs, pickPane } from "../../bin/pi-sessions.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn(), spawnSync: vi.fn() }));

const tmux = vi.mocked(execFileSync);
const fzf = vi.mocked(spawnSync);
const records = [
  { paneId: "%1", cwd: "/idle", state: "idle" as const },
  { paneId: "%2", cwd: "/repo\twith\ncontrols\x1b", state: "needs-permission" as const },
  { paneId: "%3", cwd: "/gone", state: "working" as const },
];

beforeEach(() => {
  vi.resetAllMocks();
  tmux.mockReturnValue("%1\t$0:@0.%1\tproject:1:shell.0\n%2\t$0:@1.%2\tproject:2:pi.1\n");
});

test("pick parses only its supported options and leaves next compatible", () => {
  expect(parseArgs(["pick", "--client", "/dev/pts/4"])).toEqual({
    type: "pick",
    targetClient: "/dev/pts/4",
  });
  expect(parseArgs(["next", "--from", "%1"])).toEqual({ type: "focus_next", currentPaneId: "%1" });
  expect(() => parseArgs(["pick", "--from", "%1"])).toThrow(/usage:/);
  expect(() => parseArgs(["pick", "--client"])).toThrow(/usage:/);
});

test("picker lists existing tracked panes in state order, previews safely, and focuses the caller", () => {
  fzf.mockImplementation((_command, _args, options) => {
    if (typeof options?.input !== "string") throw new Error("expected text input");
    const rows = options.input.trimEnd().split("\n");
    expect(rows).toEqual([
      "%2\t$0:@1.%2\tneeds-permission  project:2:pi.1  /repo with controls   %2",
      "%1\t$0:@0.%1\tidle              project:1:shell.0  /idle  %1",
    ]);
    return { status: 0, stdout: `${rows[0]}\n`, stderr: "", pid: 1, signal: null, output: [] };
  });
  pickPane(records, "/dev/pts/4");
  expect(fzf.mock.calls[0]?.[1]).toContain("--preview=tmux capture-pane -e -p -t {1}");
  expect(fzf.mock.calls[0]?.[2]?.env).toMatchObject({
    FZF_DEFAULT_OPTS: "",
    FZF_DEFAULT_OPTS_FILE: "",
  });
  expect(fzf.mock.calls[0]?.[1]).toContain("--preview-window=right,60%,nowrap,follow");
  expect(fzf.mock.calls[0]?.[1]).toContain(
    "--bind=ctrl-d:preview-half-page-down,ctrl-u:preview-half-page-up,ctrl-r:refresh-preview",
  );
  expect(tmux).toHaveBeenLastCalledWith(
    "tmux",
    ["switch-client", "-c", "/dev/pts/4", "-t", "$0:@1.%2"],
    {
      stdio: "inherit",
    },
  );
});

test.each([1, 130])("fzf exit %s cancels without changing focus", (status) => {
  fzf.mockReturnValue({ status, stdout: "", stderr: "", pid: 1, signal: null, output: [] });
  pickPane(records, undefined);
  expect(tmux).toHaveBeenCalledTimes(1);
});

test("empty lists, fzf failures, and foreign selections never focus a pane", () => {
  expect(() => pickPane([], undefined)).toThrow(/no tracked Pi panes/);
  fzf.mockReturnValue({ status: 2, stdout: "", stderr: "", pid: 1, signal: null, output: [] });
  expect(() => pickPane(records, undefined)).toThrow(/fzf failed/);
  fzf.mockReturnValue({
    status: 0,
    stdout: "%999\tforeign",
    stderr: "",
    pid: 1,
    signal: null,
    output: [],
  });
  expect(() => pickPane(records, undefined)).toThrow(/invalid fzf selection/);
  expect(tmux.mock.calls.every((call) => call[1]?.[0] === "list-panes")).toBe(true);
});
