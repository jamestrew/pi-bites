import { createRequire } from "node:module";
import { basename } from "node:path";

export interface BashSimpleCommand {
  name?: string;
  subcommand?: string;
  argv: string[];
  flags: string[];
}

export interface BashRedirect {
  operator: string;
  target?: string;
}

export interface BashFacts {
  commands: BashSimpleCommand[];
  redirects: BashRedirect[];
  pathCandidates: string[];
  hasPipe: boolean;
  hasVariableAssignment: boolean;
}

interface TSNode {
  readonly type: string;
  readonly text: string;
  readonly childCount: number;
  child(index: number): TSNode | null;
}

interface TSParser {
  parse(input: string): { rootNode: TSNode; delete(): void } | null;
  delete(): void;
}

const SKIP_SUBTREE_TYPES = new Set(["comment", "heredoc_body", "heredoc_end"]);
const ARG_NODE_TYPES = new Set(["word", "concatenation", "string", "raw_string"]);
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const REGEX_METACHAR_PATTERN = /\.\*|\.\+|\\\||\\\(|\\\)|\[.*?\]|\^\//;

let parserPromise: Promise<TSParser> | null = null;

async function initParser(): Promise<TSParser> {
  const { Parser, Language } = await import("web-tree-sitter");
  const req = createRequire(import.meta.url);

  const treeSitterWasm = req.resolve("web-tree-sitter/web-tree-sitter.wasm");
  await Parser.init({ locateFile: () => treeSitterWasm });

  const parser = new Parser();
  const bashWasm = req.resolve("tree-sitter-bash/tree-sitter-bash.wasm");
  const bash = await Language.load(bashWasm);
  parser.setLanguage(bash);
  return parser;
}

function getParser(): Promise<TSParser> {
  parserPromise ??= initParser();
  return parserPromise;
}

function resolveNodeText(node: TSNode): string {
  switch (node.type) {
    case "word":
    case "string_content":
    case "simple_expansion":
    case "expansion":
      return node.text;
    case "raw_string": {
      const text = node.text;
      if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
        return text.slice(1, -1);
      }
      return text;
    }
    case "string":
    case "concatenation": {
      let result = "";
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child || child.type === '"') continue;
        result += resolveNodeText(child);
      }
      return result;
    }
    default:
      return node.text;
  }
}

function extractArgv(node: TSNode): string[] {
  const argv: string[] = [];
  let consumedImplicitCommandName = false;

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (child.type === "command_name") {
      argv.push(resolveNodeText(child));
      consumedImplicitCommandName = true;
      continue;
    }

    if (child.type === "variable_assignment") continue;

    if (ARG_NODE_TYPES.has(child.type)) {
      if (!consumedImplicitCommandName) {
        argv.push(resolveNodeText(child));
        consumedImplicitCommandName = true;
        continue;
      }

      argv.push(resolveNodeText(child));
      continue;
    }
  }

  return argv.filter(Boolean);
}

function extractCommandName(argv: string[]): string | undefined {
  const first = argv[0];
  return first ? basename(first) : undefined;
}

function extractRedirect(node: TSNode): BashRedirect {
  let operator = node.text.trim();
  let target: string | undefined;

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (ARG_NODE_TYPES.has(child.type)) {
      target = resolveNodeText(child);
      continue;
    }

    if (
      child.type.includes("redirect") ||
      child.type === ">" ||
      child.type === ">>" ||
      child.type === "<&" ||
      child.type === ">&" ||
      child.type === "<"
    ) {
      operator = child.text;
    }
  }

  if (target && operator.includes(target)) {
    operator = operator.slice(0, operator.indexOf(target)).trim();
  }

  return {
    operator: operator || node.text.trim(),
    target,
  };
}

function classifyTokenAsPathCandidate(token: string): string | null {
  if (!token) return null;
  if (token.startsWith("-")) return null;

  const eqIndex = token.indexOf("=");
  const slashIndex = token.indexOf("/");
  if (eqIndex !== -1 && (slashIndex === -1 || eqIndex < slashIndex)) {
    return null;
  }

  if (URL_PATTERN.test(token)) return null;
  if (token.startsWith("@") && !token.startsWith("@/")) return null;
  if (/^\/+$/u.test(token)) return null;
  if (REGEX_METACHAR_PATTERN.test(token)) return null;

  if (token.startsWith(".")) return token;
  if (token.includes("/")) return token;
  if (token.startsWith("~/")) return token;
  if (token.includes("..")) return token;

  return null;
}

function walk(node: TSNode, facts: BashFacts): void {
  if (SKIP_SUBTREE_TYPES.has(node.type)) return;

  if (node.type === "pipeline") {
    facts.hasPipe = true;
  }

  if (node.type === "variable_assignment") {
    facts.hasVariableAssignment = true;
  }

  if (node.type === "command") {
    const argv = extractArgv(node);
    facts.commands.push({
      name: extractCommandName(argv),
      subcommand: argv[1],
      argv,
      flags: argv.filter((arg, index) => index > 0 && arg.startsWith("-")),
    });

    for (const arg of argv.slice(1)) {
      const pathCandidate = classifyTokenAsPathCandidate(arg);
      if (pathCandidate) facts.pathCandidates.push(pathCandidate);
    }
  }

  if (node.type === "file_redirect") {
    const redirect = extractRedirect(node);
    facts.redirects.push(redirect);
    if (redirect.target) {
      const pathCandidate = classifyTokenAsPathCandidate(redirect.target);
      if (pathCandidate) facts.pathCandidates.push(pathCandidate);
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walk(child, facts);
  }
}

export async function extractBashFacts(command: string): Promise<BashFacts> {
  const parser = await getParser();
  const tree = parser.parse(command);
  if (!tree) {
    return {
      commands: [],
      redirects: [],
      pathCandidates: [],
      hasPipe: false,
      hasVariableAssignment: false,
    };
  }

  const facts: BashFacts = {
    commands: [],
    redirects: [],
    pathCandidates: [],
    hasPipe: false,
    hasVariableAssignment: false,
  };

  try {
    walk(tree.rootNode, facts);
  } finally {
    tree.delete();
  }

  facts.pathCandidates = [...new Set(facts.pathCandidates)];
  return facts;
}
