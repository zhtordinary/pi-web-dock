import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { mutateResourceDocument, readResourceDocument } from "./resource-config-file.ts";
import type { CustomPrompt, CustomPromptState } from "./custom-prompt-types.ts";

export function getCustomPromptsFilePath(): string {
  return resolve(process.env.PI_WEB_CUSTOM_PROMPTS_FILE || join(getAgentDir(), "custom-prompts.json"));
}

function normalize(value: unknown): CustomPromptState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid custom prompts file format");
  }
  const rawPrompts = (value as { prompts?: unknown }).prompts;
  if (!Array.isArray(rawPrompts)) throw new Error("Invalid custom prompts file format");

  const prompts: CustomPrompt[] = [];
  rawPrompts.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const raw = item as Record<string, unknown>;
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const content = typeof raw.content === "string" ? raw.content : "";
    if (!title && !content) return;
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `legacy-prompt-${index}`;
    const description = typeof raw.description === "string" && raw.description.trim() ? raw.description.trim() : undefined;
    const order = typeof raw.order === "number" && Number.isFinite(raw.order) ? raw.order : index;
    const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;
    prompts.push({ id, title: title || content.slice(0, 30), content, description, order, updatedAt });
  });

  prompts.sort((a, b) => a.order - b.order || b.updatedAt - a.updatedAt);
  return {
    version: 1,
    prompts,
  };
}

function project(document: Record<string, unknown>): CustomPromptState {
  return Object.keys(document).length === 0 ? { version: 1, prompts: [] } : normalize(document);
}

export function inspectCustomPrompts() {
  const snapshot = readResourceDocument(getCustomPromptsFilePath());
  return { revision: snapshot.revision, value: { prompts: project(snapshot.document).prompts } };
}

export interface CustomPromptInput {
  id?: string;
  title: string;
  content: string;
  description?: string;
  order?: number;
}

export type CustomPromptsMutation =
  | { operation: "upsert"; changes: CustomPromptInput }
  | { operation: "delete"; changes: { id: string } }
  | { operation: "reorder"; changes: { orderedIds: string[] } };

export function mutateCustomPrompts(mutation: CustomPromptsMutation, expectedRevision?: string) {
  const result = mutateResourceDocument(getCustomPromptsFilePath(), expectedRevision, (document) => {
    const state = project(document);
    let target: CustomPrompt | undefined;
    let deleted = false;
    if (mutation.operation === "upsert") {
      const input = mutation.changes;
      const title = input.title.trim();
      const content = input.content;
      const existingIndex = input.id ? state.prompts.findIndex((prompt) => prompt.id === input.id) : -1;
      const existing = existingIndex >= 0 ? state.prompts[existingIndex] : undefined;
      target = {
        id: input.id || randomUUID(),
        title: title || existing?.title || content.slice(0, 30),
        content,
        description: input.description?.trim() || undefined,
        order: input.order ?? existing?.order ?? state.prompts.length,
        updatedAt: Date.now(),
      };
      if (existingIndex >= 0) state.prompts[existingIndex] = target;
      else state.prompts.push(target);
    } else if (mutation.operation === "delete") {
      const length = state.prompts.length;
      state.prompts = state.prompts.filter((prompt) => prompt.id !== mutation.changes.id);
      deleted = state.prompts.length !== length;
      if (!deleted) return { prompts: state.prompts, target, deleted };
    } else {
      const remaining = new Map(state.prompts.map((prompt) => [prompt.id, prompt]));
      const prompts: CustomPrompt[] = [];
      for (const id of mutation.changes.orderedIds) {
        const prompt = remaining.get(id);
        if (!prompt) continue;
        prompts.push({ ...prompt, order: prompts.length });
        remaining.delete(id);
      }
      for (const prompt of remaining.values()) prompts.push({ ...prompt, order: prompts.length });
      state.prompts = prompts;
    }
    state.prompts.sort((a, b) => a.order - b.order || b.updatedAt - a.updatedAt);
    // Keep fields owned by newer builds; only expose the explicit prompt projection.
    const originals = new Map<string, Record<string, unknown>>();
    if (Array.isArray(document.prompts)) for (const raw of document.prompts) {
      if (raw && typeof raw === "object" && !Array.isArray(raw) && typeof raw.id === "string") originals.set(raw.id, raw);
    }
    document.version = 1;
    document.prompts = state.prompts.map((prompt) => ({ ...originals.get(prompt.id), ...prompt }));
    return { prompts: state.prompts, target, deleted };
  });
  return { revision: result.revision, changed: result.changed, value: { prompts: result.result.prompts }, target: result.result.target, deleted: result.result.deleted };
}

export function readCustomPrompts(): CustomPrompt[] {
  return inspectCustomPrompts().value.prompts;
}

export function saveCustomPrompt(input: CustomPromptInput): CustomPrompt {
  return mutateCustomPrompts({ operation: "upsert", changes: input }).target!;
}

export function deleteCustomPrompt(id: string): boolean {
  return mutateCustomPrompts({ operation: "delete", changes: { id } }).deleted;
}

export function reorderCustomPrompts(orderedIds: string[]): CustomPrompt[] {
  return mutateCustomPrompts({ operation: "reorder", changes: { orderedIds } }).value.prompts;
}
