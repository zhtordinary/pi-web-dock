import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { observeResponseServiceTier, observedResponseServiceTier } from "./discovery";

export const READER_USAGE_PRICING_EXTENSION_ID = "pi-web-usage-pricing";

const SKILL_RELATIVE = [".agents", "skills", "pi-sync-maintenance"] as const;
const ENGINE_FILES = ["genai-prices-engine.cjs", "engine.cjs"] as const;

function expand(value: string): string {
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function syncRoots(): string[] {
  const configured = expand(String(process.env.PI_SYNC_ROOT ?? "").trim());
  const fallback = path.join(os.homedir(), "Sync");
  return unique([...(configured ? [configured, path.join(configured, "pi-state")] : []), fallback, path.join(fallback, "pi-state")]);
}

function managedSkillRootCandidates(): string[] {
  const home = os.homedir();
  const roots = [
    path.join(home, ...SKILL_RELATIVE),
    path.join(home, ".pi", "agent", "skills", "pi-sync-maintenance"),
    ...syncRoots().map((root) => path.join(root, "agent", "skills", "pi-sync-maintenance")),
    ...syncRoots().map((root) => path.join(root, ".agents", "skills", "pi-sync-maintenance")),
  ];
  return unique(roots);
}

/** Use the same session-cost script search roots as Reader's final billing path. */
export function billingScriptCandidates(): string[] {
  return unique([
    expand(String(process.env.PI_CONVERSATION_COST_SCRIPT ?? "").trim()),
    ...managedSkillRootCandidates().map((root) => path.join(root, "scripts", "session_cost.py")),
  ]);
}

function realFile(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  try {
    const resolved = realpathSync(candidate);
    return statSync(resolved).isFile() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/** Match the selected session-cost script's CLI and the CLI's engine selection. */
export function pricingEngineCandidates(): string[] {
  const configuredScript = expand(String(process.env.PI_CONVERSATION_COST_SCRIPT ?? "").trim());
  const configuredCli = expand(String(process.env.PI_GENAI_PRICES_CLI ?? "").trim());
  const configuredEngine = expand(String(process.env.PI_GENAI_PRICES_ENGINE ?? "").trim());
  if ([configuredScript, configuredCli, configuredEngine].some((value) => value && !path.isAbsolute(value))) return [];
  const roots = managedSkillRootCandidates();
  const script = realFile(billingScriptCandidates().find((candidate) => existsSync(candidate)));
  if (!script || !roots.some((root) => realFile(path.join(root, "scripts", "session_cost.py")) === script)) return [];
  const cli = [
    configuredCli,
    path.join(path.dirname(path.dirname(script)), "genai-prices", "cli.cjs"),
    path.join(os.homedir(), ...SKILL_RELATIVE, "genai-prices", "cli.cjs"),
  ].map(realFile).find(Boolean);
  if (!cli || !roots.some((root) => realFile(path.join(root, "genai-prices", "cli.cjs")) === cli)) return [];
  const selected = ENGINE_FILES.map((file) => path.join(path.dirname(cli), file)).find((file) => existsSync(file));
  const engine = realFile(selected);
  if (!engine || (configuredEngine && realFile(configuredEngine) !== engine)) return [];
  return [engine];
}

type UsageCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

type AssistantMessageLike = {
  role?: string;
  provider?: string;
  model?: string;
  timestamp?: number;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cacheWrite1h?: number;
    reasoning?: number;
    totalTokens?: number;
    cost?: Partial<UsageCost> & { totalFromProvider?: boolean };
  };
  service_tier?: string;
  response_service_tier?: string;
  [key: string]: unknown;
};

type PricingResult = {
  configured: boolean;
  status: string;
  cost: UsageCost | null;
};

export type PricingEngine = {
  isGatewayProvider(provider: string): boolean;
  priceJsonRecord(input: {
    model: string;
    provider: string;
    timestamp: number;
    inputIncludesCache: boolean;
    usage: {
      input: number;
      cacheRead: number;
      cacheWrite: number;
      cacheWrite1h: number;
      output: number;
      reasoning: number;
      totalTokens: number;
    };
    response_service_tier?: string;
  }): PricingResult;
};

const PRICING_PROCESS_TIMEOUT_MS = 5_000;
const PRICING_PROCESS_MAX_OUTPUT = 256 * 1024;
const PRICING_WORKER_SOURCE = `
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const engine = require(process.argv[1]);
    process.stdout.write(JSON.stringify(engine.priceJsonRecord(JSON.parse(input))));
  } catch {
    process.exitCode = 1;
  }
});
`;

function numberOrZero(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function amountOrZero(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function timestampOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function priceJsonRecordInFreshProcess(
  enginePath: string,
  input: Parameters<PricingEngine["priceJsonRecord"]>[0],
): Promise<PricingResult | undefined> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", PRICING_WORKER_SOURCE, enginePath], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined);
    }, PRICING_PROCESS_TIMEOUT_MS);
    const finish = (value: PricingResult | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output, "utf8") > PRICING_PROCESS_MAX_OUTPUT) {
        child.kill("SIGKILL");
        finish(undefined);
      }
    });
    child.once("error", () => finish(undefined));
    child.once("close", (code, signal) => {
      if (code !== 0 || signal || settled) {
        finish(undefined);
        return;
      }
      try {
        finish(JSON.parse(output) as PricingResult);
      } catch {
        finish(undefined);
      }
    });
    child.stdin.once("error", () => finish(undefined));
    child.stdin.end(JSON.stringify(input));
  });
}

/** Add native message-level cost metadata without changing Reader's aggregate billing source. */
export async function repriceAssistantMessage(
  message: AssistantMessageLike,
  pricingEngine?: PricingEngine,
): Promise<AssistantMessageLike | undefined> {
  if (message.role !== "assistant" || !message.provider || !message.model || !message.usage) return undefined;

  const usage = message.usage;
  const normalizedUsage = {
    input: numberOrZero(usage.input),
    cacheRead: numberOrZero(usage.cacheRead),
    cacheWrite: numberOrZero(usage.cacheWrite),
    cacheWrite1h: Math.min(numberOrZero(usage.cacheWrite1h), numberOrZero(usage.cacheWrite)),
    output: numberOrZero(usage.output),
    reasoning: numberOrZero(usage.reasoning),
    totalTokens: numberOrZero(usage.totalTokens),
  };
  const tokenCount = normalizedUsage.input
    + normalizedUsage.cacheRead
    + normalizedUsage.cacheWrite
    + normalizedUsage.output;
  if (tokenCount <= 0) return undefined;

  // Preserve any provider-declared cost, including an explicit zero charge.
  if (usage.cost?.totalFromProvider === true || amountOrZero(usage.cost?.total) > 0) return undefined;

  const timestamp = timestampOrUndefined(message.timestamp);
  if (timestamp === undefined) return undefined;

  const responseTier = observedResponseServiceTier(message);
  const pricingInput = {
    model: message.model,
    provider: message.provider,
    timestamp,
    inputIncludesCache: false,
    usage: normalizedUsage,
    ...(responseTier ? { response_service_tier: responseTier } : {}),
  };
  let priced: PricingResult | undefined;
  try {
    if (pricingEngine) {
      if (pricingEngine.isGatewayProvider(message.provider)) return undefined;
      priced = pricingEngine.priceJsonRecord(pricingInput);
    } else {
      const enginePath = pricingEngineCandidates()[0];
      if (!enginePath) return undefined;
      priced = await priceJsonRecordInFreshProcess(enginePath, pricingInput);
    }
  } catch {
    return undefined;
  }
  if (!priced?.configured || priced.status !== "calculated" || !priced.cost) return undefined;

  return {
    ...message,
    usage: {
      ...usage,
      cost: priced.cost,
    },
  };
}

/** Required by Reader-owned native pi-subagents children for their usage aggregation. */
export default function readerUsagePricing(pi: ExtensionAPI): void {
  observeResponseServiceTier(pi);
  pi.on("message_end", async (event) => {
    const repriced = await repriceAssistantMessage(event.message as AssistantMessageLike);
    return repriced ? { message: repriced as typeof event.message } : undefined;
  });
  pi.events.emit("subagent:acknowledge-extension", { id: READER_USAGE_PRICING_EXTENSION_ID });
}
