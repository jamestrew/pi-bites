import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageName = "@earendil-works/pi-coding-agent";
const statePath = "docs/upstream-watch/state.json";
const latestReportPath = "docs/upstream-watch/latest.md";

type State = {
  lastCheckedVersion: string;
  lastCheckedAt?: string;
  reports?: string[];
};

type Entry = {
  version: string;
  content: string;
};

async function main() {
  await mkdir("docs/upstream-watch", { recursive: true });
  const state = await readState();
  const latest = await getLatestPackageInfo();
  const changelog = await fetchChangelog(latest.tarball);
  const entries = parseChangelog(changelog).filter(
    (entry) => compareVersions(entry.version, state.lastCheckedVersion) > 0,
  );
  const report = renderReport(state, latest.version, entries);
  await writeFile(latestReportPath, report);
  console.log(`Wrote ${latestReportPath}`);
  console.log(
    `${entries.length} changelog entr${entries.length === 1 ? "y" : "ies"} since ${state.lastCheckedVersion}; latest is ${latest.version}.`,
  );
}

async function readState(): Promise<State> {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const installed = await readInstalledVersion();
    const state = {
      lastCheckedVersion: installed,
      lastCheckedAt: new Date().toISOString().slice(0, 10),
      reports: [],
    };
    await writeFile(statePath, `${JSON.stringify(state, null, "\t")}\n`);
    return state;
  }
}

async function readInstalledVersion() {
  const packageJson = JSON.parse(
    await readFile(`node_modules/${packageName}/package.json`, "utf8"),
  );
  return packageJson.version as string;
}

async function getLatestPackageInfo() {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(packageName).replace("%40", "@")}/latest`,
  );
  if (!response.ok)
    throw new Error(`Failed to fetch npm metadata: ${response.status} ${response.statusText}`);
  const metadata = (await response.json()) as { version: string; dist: { tarball: string } };
  return { version: metadata.version, tarball: metadata.dist.tarball };
}

async function fetchChangelog(tarballUrl: string) {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-upstream-"));
  const tarballPath = join(tempDir, "package.tgz");
  try {
    const response = await fetch(tarballUrl);
    if (!response.ok)
      throw new Error(`Failed to fetch tarball: ${response.status} ${response.statusText}`);
    await writeFile(tarballPath, Buffer.from(await response.arrayBuffer()));
    const proc = Bun.spawn(["tar", "-xzf", tarballPath, "package/CHANGELOG.md"], {
      cwd: tempDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) throw new Error(`tar failed: ${await new Response(proc.stderr).text()}`);
    return await readFile(join(tempDir, "package", "CHANGELOG.md"), "utf8");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function parseChangelog(markdown: string): Entry[] {
  const matches = [...markdown.matchAll(/^##\s+\[?(?:v)?(\d+\.\d+\.\d+)\]?(?:\s+-\s+.*)?$/gm)];
  return matches.map((match, index) => {
    const start = match.index! + match[0].length;
    const end = matches[index + 1]?.index ?? markdown.length;
    return { version: match[1], content: markdown.slice(start, end).trim() };
  });
}

function compareVersions(a: string, b: string) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] > right[i]) return 1;
    if (left[i] < right[i]) return -1;
  }
  return 0;
}

function renderReport(state: State, latestVersion: string, entries: Entry[]) {
  const today = new Date().toISOString().slice(0, 10);
  const body =
    entries.length === 0
      ? "No upstream changelog entries are newer than the checkpoint.\n"
      : entries.map((entry) => `## ${entry.version}\n\n${entry.content}`).join("\n\n");
  return `# Pi upstream watch — ${today}\n\nPackage: \`${packageName}\`\nCheckpoint: \`${state.lastCheckedVersion}\`\nLatest upstream: \`${latestVersion}\`\n\n## Agent review checklist\n\nClassify every entry below as \`adapt\`, \`leverage\`, \`watch\`, or \`irrelevant\`. Cross-reference local extension code before recommending action. Do not update \`${statePath}\` until the review is accepted.\n\nLocal surfaces to check first: \`packages/ext/index.ts\`, \`packages/ext/config.ts\`, \`packages/ext/tools.ts\`, \`packages/ext/explore/\`, \`packages/ext/statusline.ts\`, \`packages/ext/notifications.ts\`, \`packages/ext/file-search/\`, \`packages/ext/inline-references/\`, and docs under \`README.md\`.\n\n## Upstream entries\n\n${body}\n`;
}

await main();
