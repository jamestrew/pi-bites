import { createRequire } from "node:module";
import { basename } from "node:path";

export interface BashSimpleCommand {
  name?: string;
  subcommand?: string;
  argv: string[];
  dynamicArgIndexes?: number[];
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
const DOUBLE_QUOTED_ESCAPES = new Set(["$", "`", '"', "\\"]);
const DYNAMIC_ARG_NODE_TYPES = new Set([
  "arithmetic_expansion",
  "command_substitution",
  "expansion",
  "process_substitution",
  "simple_expansion",
]);
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

function unescapeShellText(text: string, escapable?: ReadonlySet<string>): string {
  let result = "";
  for (let index = 0; index < text.length; index++) {
    const next = text[index + 1];
    if (text[index] !== "\\" || next === undefined) {
      result += text[index];
    } else if (next === "\n") {
      index++;
    } else if (!escapable || escapable.has(next)) {
      result += next;
      index++;
    } else {
      result += "\\";
    }
  }
  return result;
}

function resolveNodeText(node: TSNode): string {
  switch (node.type) {
    case "word":
      return unescapeShellText(node.text);
    case "string_content":
      return unescapeShellText(node.text, DOUBLE_QUOTED_ESCAPES);
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

function hasDynamicArgNode(node: TSNode): boolean {
  if (DYNAMIC_ARG_NODE_TYPES.has(node.type)) return true;
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (child && hasDynamicArgNode(child)) return true;
  }
  return false;
}

function hasUnescapedPattern(text: string): boolean {
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "*" || char === "?" || char === "[" || char === "{") {
      return true;
    }
  }
  return false;
}

function hasDynamicPattern(node: TSNode): boolean {
  if (node.type === "raw_string" || node.type === "string") return false;
  if (node.type === "word") return hasUnescapedPattern(node.text);
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (child && hasDynamicPattern(child)) return true;
  }
  return false;
}

function isDynamicArg(node: TSNode): boolean {
  if (hasDynamicArgNode(node)) return true;
  if (node.type !== "raw_string" && node.type !== "string" && node.text.startsWith("~"))
    return true;
  return hasDynamicPattern(node);
}

function extractArgv(node: TSNode): { argv: string[]; dynamicArgIndexes: number[] } {
  const argv: string[] = [];
  const dynamicArgIndexes: number[] = [];
  let consumedImplicitCommandName = false;

  const append = (child: TSNode) => {
    const text = resolveNodeText(child);
    if (!text) return;
    if (isDynamicArg(child)) dynamicArgIndexes.push(argv.length);
    argv.push(text);
  };

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (child.type === "command_name") {
      append(child);
      consumedImplicitCommandName = true;
      continue;
    }

    if (child.type === "variable_assignment") continue;

    if (ARG_NODE_TYPES.has(child.type)) {
      if (!consumedImplicitCommandName) {
        append(child);
        consumedImplicitCommandName = true;
        continue;
      }

      append(child);
      continue;
    }
  }

  return { argv, dynamicArgIndexes };
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
    const { argv, dynamicArgIndexes } = extractArgv(node);
    facts.commands.push({
      name: extractCommandName(argv),
      subcommand: argv[1],
      argv,
      dynamicArgIndexes,
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
