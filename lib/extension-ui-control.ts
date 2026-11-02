import { createHash } from "node:crypto";
/** The live wrapper owns questions. Historical events never restore a resolver. */
export function uiControlError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function uiResponseSchema(request: Record<string, unknown>) {
  if (request.method === "select") return { kind: "select", options: request.options, allowFreeText: false };
  if (request.method === "confirm") return { kind: "confirm", allowFreeText: false };
  if (request.method === "input" || request.method === "editor") return { kind: "text", allowFreeText: true };
  return { kind: "custom", allowFreeText: false, supported: false };
}

export function validateUiResponse(request: Record<string, unknown>, response: Record<string, unknown>): string {
  const fields = ["value", "confirmed", "cancelled"].filter(key => Object.hasOwn(response, key));
  if (fields.length !== 1) throw uiControlError("ui_response_invalid", "Submit exactly one of value, confirmed, or cancelled");
  if (fields[0] === "cancelled") {
    if (response.cancelled !== true) throw uiControlError("ui_response_invalid", "cancelled must be true");
    return createHash("sha256").update(JSON.stringify({ cancelled: true })).digest("hex");
  }
  if (request.method === "confirm") {
    if (fields[0] !== "confirmed" || typeof response.confirmed !== "boolean") throw uiControlError("ui_response_invalid", "This request requires a boolean confirmed response");
    return createHash("sha256").update(JSON.stringify({ confirmed: response.confirmed })).digest("hex");
  }
  if (!["select", "input", "editor"].includes(String(request.method)) || fields[0] !== "value" || typeof response.value !== "string") {
    throw uiControlError("ui_response_invalid", "This request requires a text value or a supported custom UI interaction");
  }
  if (request.method === "select" && (!Array.isArray(request.options) || !request.options.includes(response.value))) {
    throw uiControlError("ui_response_invalid", "Select an advertised option. For a manual answer, choose the extension's manual-input option, then answer its new input request.");
  }
  return createHash("sha256").update(JSON.stringify({ value: response.value })).digest("hex");
}
