import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { imageGenerationOutputFromTask, imageGenerationOutputFromTool, readImageGenerationBilling } from "./image-generation-cost";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Keep output identity beside the existing usage event, including nested tool calls. */
export function createImageGenerationOutputExtension(): InlineExtension {
  return {
    name: "pi-web-image-generation-output",
    hidden: true,
    factory: (pi) => {
      pi.on("tool_result", async (event, ctx) => {
        if (event.isError) return;
        try {
          let output = imageGenerationOutputFromTool(event.toolCallId, event.toolName, event.details);
          if (!output && event.toolName === "generation_task" && event.input.action === "recover"
              && record(event.details) && record(event.details.task)
              && JSON.stringify(event.details.files) === JSON.stringify(event.details.task.files)) {
            const receipts = ctx.sessionManager.getEntries().flatMap((entry) => {
              if (entry.type !== "custom" || entry.customType !== "image-generation-usage" || !record(entry.data)
                  || !record(entry.data.usageEvent) || typeof entry.data.usageEvent.id !== "string"
                  || typeof entry.data.provider !== "string" || typeof entry.data.model !== "string") return [];
              const billing = readImageGenerationBilling(entry.data.billing);
              return billing ? [{ id: entry.data.usageEvent.id, provider: entry.data.provider, model: entry.data.model, billing }] : [];
            });
            output = imageGenerationOutputFromTask(event.details.task, ctx.sessionManager.getSessionId(), receipts);
          }
          if (output) pi.appendEntry("image-generation-output", output);
        } catch { /* Recording image metadata must not discard a delivered image. */ }
      });
    },
  };
}
