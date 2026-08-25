import { randomUUID } from "node:crypto";
import { Text } from "@earendil-works/pi-tui";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import type { CodexAdapterConfig } from "../../config.js";
import { nativeBinaryRecoveryMessage } from "../native-binary-error.js";
import { runBundledTool } from "../native/runner.js";
import { getBundledWebRunPath } from "./binary.js";

const RESPONSES_APIS = new Set([
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
]);
const STOCK_CODEX_PROVIDER = "openai-codex";
const MAX_NAVIGATION_CALLS = 32;
const MAX_NATIVE_OUTPUT_BYTES = 8 * 1024 * 1024;

const query = Type.Object(
  {
    q: Type.String(),
    recency: Type.Optional(Type.Integer({ minimum: 0, description: "Recent days" })),
    domains: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
  },
  { additionalProperties: false },
);

const parameters = Type.Object(
  {
    search_query: Type.Optional(Type.Array(query, { minItems: 1, maxItems: 4 })),
    image_query: Type.Optional(Type.Array(query, { minItems: 1, maxItems: 4 })),
    open: Type.Optional(
      Type.Array(
        Type.Object(
          { ref_id: Type.String(), lineno: Type.Optional(Type.Integer({ minimum: 0 })) },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 10, description: "Reference IDs or URLs to open" },
      ),
    ),
    click: Type.Optional(
      Type.Array(
        Type.Object(
          { ref_id: Type.String(), id: Type.Integer({ minimum: 0 }) },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 10 },
      ),
    ),
    find: Type.Optional(
      Type.Array(
        Type.Object(
          { ref_id: Type.String(), pattern: Type.String() },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 10 },
      ),
    ),
    response_length: Type.Optional(
      Type.Union([Type.Literal("short"), Type.Literal("medium"), Type.Literal("long")]),
    ),
    settings: Type.Optional(
      Type.Object(
        {
          search_context_size: Type.Optional(
            Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

type WebRunParameters = Static<typeof parameters>;

interface AdapterModel {
  provider?: string;
  id?: string;
  api?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

interface SelectedRoute {
  kind: "stock" | "compatible" | "fallback";
  label: string;
  model: AdapterModel;
}

type ResolvedAuth =
  | {
      ok: true;
      apiKey?: string;
      headers?: Record<string, string | null>;
      baseUrl?: string;
    }
  | { ok: false; error: string };

export interface WebRunNativeInput {
  route: string;
  url: string;
  headers: Record<string, string>;
  params: Record<string, unknown>;
  signal?: AbortSignal;
}

interface WebRunOutput extends Record<string, unknown> {
  output?: string;
  output_text?: string;
  text?: string;
}

export interface WebRunDetails {
  route: "stock" | "compatible" | "fallback";
  webRun: WebRunOutput;
}

export interface CreateWebRunToolOptions {
  getConfig: () => CodexAdapterConfig;
  binaryPath?: string;
  runNative?: (input: WebRunNativeInput) => Promise<string>;
}

const normalize = (value: string | undefined): string => value?.trim().toLowerCase() ?? "";

function isResponsesModel(model: AdapterModel | undefined): boolean {
  return model !== undefined && RESPONSES_APIS.has(normalize(model.api));
}

function isStockCodex(model: AdapterModel | undefined): boolean {
  return normalize(model?.provider) === STOCK_CODEX_PROVIDER;
}

function isAllowlisted(model: AdapterModel | undefined, config: CodexAdapterConfig): boolean {
  const provider = normalize(model?.provider);
  return (config.webSearchProviders ?? []).some((allowed) => normalize(allowed) === provider);
}

export function isWebRunAvailable(
  model: AdapterModel | undefined,
  config: CodexAdapterConfig,
): boolean {
  if (!model) return false;
  return (
    (isStockCodex(model) && isResponsesModel(model)) ||
    (isAllowlisted(model, config) && isResponsesModel(model)) ||
    config.allowOpenAICodexFallback === true
  );
}

function fallbackModel(
  models: AdapterModel[],
  activeModel: AdapterModel,
): AdapterModel | undefined {
  return models
    .filter((model) => isStockCodex(model) && isResponsesModel(model))
    .sort((left, right) => {
      const leftMatches = left.id === activeModel.id ? 0 : 1;
      const rightMatches = right.id === activeModel.id ? 0 : 1;
      return leftMatches - rightMatches || normalize(left.id).localeCompare(normalize(right.id));
    })[0];
}

function selectRoute(
  activeModel: AdapterModel | undefined,
  config: CodexAdapterConfig,
  models: AdapterModel[],
): SelectedRoute {
  if (!activeModel) throw new Error("web_run is unavailable because no active model is selected");
  const provider = activeModel.provider ?? "unknown";
  if (isStockCodex(activeModel)) {
    if (!isResponsesModel(activeModel)) {
      throw new Error("stock openai-codex route requires a Responses API model");
    }
    return { kind: "stock", label: "stock openai-codex", model: activeModel };
  }
  if (isAllowlisted(activeModel, config)) {
    if (!isResponsesModel(activeModel)) {
      throw new Error(`allowlisted ${provider} route requires a Responses API model`);
    }
    return { kind: "compatible", label: `allowlisted ${provider}`, model: activeModel };
  }
  if (config.allowOpenAICodexFallback === true) {
    const model = fallbackModel(models, activeModel);
    if (!model) {
      throw new Error(
        'OpenAI Codex fallback route has no registered Responses model; update Pi and run "/login openai-codex"',
      );
    }
    return { kind: "fallback", label: "OpenAI Codex fallback", model };
  }
  throw new Error(
    `web_run has no permitted route for ${provider}; allowlist a compatible Responses provider or explicitly enable OpenAI Codex fallback`,
  );
}

function jwtAccountId(token: string): string | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const auth = value["https://api.openai.com/auth"];
    if (!auth || typeof auth !== "object") return undefined;
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === "string" && accountId.trim() ? accountId : undefined;
  } catch {
    return undefined;
  }
}

function headerEntry(headers: Record<string, string>, name: string): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const existing = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  if (existing) delete headers[existing];
  headers[name] = value;
}

function requestHeaders(route: SelectedRoute, auth: Extract<ResolvedAuth, { ok: true }>) {
  const headers: Record<string, string> = { ...route.model.headers };
  for (const [key, value] of Object.entries(auth.headers ?? {})) {
    const existing = Object.keys(headers).find((name) => name.toLowerCase() === key.toLowerCase());
    if (value === null) {
      if (existing) delete headers[existing];
    } else {
      if (existing) delete headers[existing];
      headers[key] = value;
    }
  }
  if (route.kind === "stock" || route.kind === "fallback") {
    if (auth.apiKey && !headerEntry(headers, "authorization")) {
      setHeader(headers, "Authorization", `Bearer ${auth.apiKey}`);
    }
    const authorization = headerEntry(headers, "authorization");
    if (!authorization) {
      throw new Error(`${route.label} route authentication is missing an access token`);
    }
    const token = authorization.replace(/^Bearer\s+/iu, "");
    const accountId = headerEntry(headers, "chatgpt-account-id") ?? jwtAccountId(token);
    if (!accountId) {
      throw new Error(
        `${route.label} route authentication is missing a valid ChatGPT account ID; run "/login openai-codex"`,
      );
    }
    setHeader(headers, "chatgpt-account-id", accountId);
  } else if (Object.keys(headers).length === 0) {
    throw new Error(
      `${route.label} route authentication returned no request headers; check that provider's Pi authHeader or custom headers`,
    );
  }
  setHeader(headers, "content-type", "application/json");
  if (!headerEntry(headers, "originator")) setHeader(headers, "originator", "pi");
  if (!headerEntry(headers, "version")) setHeader(headers, "version", "0.0.0");
  if (!headerEntry(headers, "user-agent")) setHeader(headers, "User-Agent", "pi-bites/web_run");
  return headers;
}

export function searchUrlFromBase(baseUrl: string, stockCodex: boolean): string {
  const base = baseUrl.trim().replace(/\/+$/u, "");
  if (base.endsWith("/alpha/search")) return base;
  if (base.endsWith("/responses")) return `${base.slice(0, -"/responses".length)}/alpha/search`;
  if (base.endsWith("/codex")) return `${base}/alpha/search`;
  if (stockCodex && (base.endsWith("/api") || base.endsWith("/backend-api"))) {
    return `${base}/codex/alpha/search`;
  }
  return `${base}/alpha/search`;
}

function nativeInputBaseUrl(
  route: SelectedRoute,
  auth: Extract<ResolvedAuth, { ok: true }>,
): string {
  return searchUrlFromBase(
    auth.baseUrl ?? route.model.baseUrl ?? "",
    route.kind === "stock" || route.kind === "fallback",
  );
}

function routeError(route: SelectedRoute, message: string): Error {
  return new Error(`${route.label} route failed: ${message}; no other provider was tried`);
}

function outputText(output: WebRunOutput): string | undefined {
  for (const value of [output.output_text, output.output, output.text]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function safeProcessEnv(): NodeJS.ProcessEnv {
  const names = [
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NIX_SSL_CERT_FILE",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
  ];
  return Object.fromEntries(
    names.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
  );
}

async function defaultNativeRunner(input: WebRunNativeInput, binaryPath?: string): Promise<string> {
  const configuredBinary = process.env.PI_CODEX_WEB_RUN_BIN?.trim();
  const binary = (binaryPath ?? configuredBinary) || getBundledWebRunPath();
  if (!binary) {
    throw new Error(`web_run binary is not bundled for ${process.platform}-${process.arch}`);
  }
  const result = await runBundledTool({
    binary,
    args: ["-"],
    stdin: JSON.stringify(input.params),
    cwd: process.cwd(),
    env: {
      ...safeProcessEnv(),
      PI_CODEX_SEARCH_URL: input.url,
      PI_CODEX_SEARCH_HEADERS: JSON.stringify(input.headers),
    },
    maxBuffer: MAX_NATIVE_OUTPUT_BYTES,
    signal: input.signal,
    label: "web_run",
    recoverNonzero: false,
  });
  if (result.status !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || "native process exited unexpectedly";
    if (/web_run search (?:request )?failed|HTTP \d{3}/iu.test(detail)) throw new Error(detail);
    throw new Error(nativeBinaryRecoveryMessage("web_run", detail) ?? detail);
  }
  return result.stdout;
}

function callDetail(params: WebRunParameters): string | undefined {
  return (
    params.search_query?.[0]?.q ??
    params.image_query?.[0]?.q ??
    params.open?.[0]?.ref_id ??
    params.click?.[0]?.ref_id ??
    params.find?.[0]?.pattern
  );
}

export function createWebRunTool(
  options: CreateWebRunToolOptions,
): ToolDefinition<typeof parameters, WebRunDetails> & { resetNavigationState(): void } {
  let navigationId = randomUUID();
  let navigationCalls = 0;
  let navigationRoute: string | undefined;
  return {
    name: "web_run",
    label: "web_run",
    description: "Search the web, find images, and navigate search results or pages.",
    promptSnippet: "Search and navigate the web with explicit arguments",
    executionMode: "parallel",
    parameters,
    resetNavigationState() {
      navigationId = randomUUID();
      navigationCalls = 0;
      navigationRoute = undefined;
    },
    prepareArguments: (args) => args as WebRunParameters,
    async execute(
      _toolCallId,
      params,
      signal,
      _onUpdate,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<WebRunDetails>> {
      // Contexts are session-bound. Snapshot all getters before auth or process awaits.
      const activeModel = ctx.model as AdapterModel | undefined;
      const registry = ctx.modelRegistry;
      const config = { ...options.getConfig() };
      const models = registry.getAll() as AdapterModel[];
      const route = selectRoute(activeModel, config, models);
      if (signal?.aborted) throw new Error(`${route.label} route cancelled before execution`);
      const auth = (await registry.getApiKeyAndHeaders(route.model as never)) as ResolvedAuth;
      if (!auth.ok) {
        const login =
          route.kind === "compatible"
            ? "check that provider's Pi auth"
            : 'run "/login openai-codex"';
        throw new Error(`${route.label} route authentication failed: ${auth.error}; ${login}`);
      }
      if (signal?.aborted)
        throw new Error(`${route.label} route cancelled before native execution`);
      const headers = requestHeaders(route, auth);
      const routeKey = `${route.kind}:${normalize(route.model.provider)}:${route.model.id ?? ""}:${nativeInputBaseUrl(route, auth)}`;
      if (navigationRoute !== routeKey || navigationCalls >= MAX_NAVIGATION_CALLS) {
        navigationId = randomUUID();
        navigationCalls = 0;
        navigationRoute = routeKey;
      }
      navigationCalls += 1;
      const nativeInput: WebRunNativeInput = {
        route: route.label,
        url: nativeInputBaseUrl(route, auth),
        headers,
        params: {
          ...params,
          id: navigationId,
          model: route.model.id,
          max_output_tokens: 8_000,
        },
        ...(signal ? { signal } : {}),
      };
      try {
        const stdout = await (
          options.runNative ?? ((input) => defaultNativeRunner(input, options.binaryPath))
        )(nativeInput);
        if (signal?.aborted) throw new Error("cancelled");
        let output: WebRunOutput;
        try {
          output = JSON.parse(stdout) as WebRunOutput;
        } catch (error) {
          throw new Error(
            `returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const text = outputText(output);
        if (!text) throw new Error("returned no output");
        return {
          content: [{ type: "text", text }],
          details: { route: route.kind, webRun: output },
        };
      } catch (error) {
        const message = signal?.aborted
          ? "cancelled"
          : error instanceof Error
            ? error.message
            : String(error);
        if (message.startsWith(`${route.label} route`)) throw error;
        throw routeError(route, message);
      }
    },
    renderCall(args, theme) {
      const detail = callDetail(args);
      return new Text(
        theme.bold("Web") + (detail ? theme.fg("toolTitle", ` ${detail}`) : ""),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const text = expanded
        ? (result.content.find((item) => item.type === "text")?.text ?? "(no output)")
        : "";
      return new Text(theme.fg("dim", text), 0, 0);
    },
  };
}

export function registerWebRunTool(pi: ExtensionAPI, options: CreateWebRunToolOptions): void {
  const tool = createWebRunTool(options);
  pi.registerTool(tool);
  pi.on("session_start", () => tool.resetNavigationState());
}
