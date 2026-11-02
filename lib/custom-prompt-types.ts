export const CUSTOM_PROMPTS_CHANGED_EVENT = "pi-web-custom-prompts-changed";

export interface CustomPrompt {
  id: string;
  title: string;
  content: string;
  description?: string;
  order: number;
  updatedAt: number;
}

export interface CustomPromptEditValue {
  id: string;
  title: string;
  description: string;
  content: string;
}

export interface CustomPromptState {
  version: 1;
  prompts: CustomPrompt[];
}
