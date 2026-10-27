import type { DesignSystemManifestInput, Placement } from "@storypage/schema";
import type { ComponentDraft, ComponentSelection } from "@storypage/schema/figma";

export interface Settings {
  gatewayUrl: string;
  token: string;
}

export type FromUi =
  | { type: "init" }
  | { type: "save-settings"; settings: Settings }
  | { type: "scan" }
  | { type: "save-selection"; nodeId: string; selection: ComponentSelection | null }
  | { type: "export-previews"; components: { name: string; nodeId: string }[] }
  | { type: "select-node"; nodeId: string }
  | { type: "notify"; message: string; error?: boolean }
  | { type: "close" };

export type ToUi =
  | { type: "settings"; settings: Settings | null; fileName: string }
  | {
      type: "scan-result";
      manifest: DesignSystemManifestInput;
      drafts: ComponentDraft[];
      selections: Record<string, ComponentSelection>;
      suggestions: Record<string, Placement>;
      warnings: string[];
    }
  | { type: "previews"; previews: Record<string, string>; warnings: string[] }
  | { type: "error"; message: string };
