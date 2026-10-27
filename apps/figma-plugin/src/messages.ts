import type { DesignSystemManifestInput } from "@storypage/schema";

export interface Settings {
  gatewayUrl: string;
  token: string;
}

export type FromUi =
  | { type: "init" }
  | { type: "save-settings"; settings: Settings }
  | { type: "scan" }
  | { type: "notify"; message: string; error?: boolean }
  | { type: "close" };

export type ToUi =
  | { type: "settings"; settings: Settings | null; fileName: string }
  | { type: "scan-result"; manifest: DesignSystemManifestInput; previews: Record<string, string>; warnings: string[] }
  | { type: "error"; message: string };
