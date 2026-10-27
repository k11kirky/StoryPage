import type { DesignSystemManifestInput } from "@storypage/schema";
import type { FromUi, Settings, ToUi } from "./messages";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const post = (message: FromUi) => parent.postMessage({ pluginMessage: message }, "*");

let settings: Settings | null = null;
let scan: { manifest: DesignSystemManifestInput; previews: Record<string, string> } | null = null;

function show(section: "settings" | "scan" | "review") {
  $("settings").hidden = section !== "settings";
  $("scan").hidden = section === "settings";
  $("review").hidden = section !== "review";
}

function status(text: string, kind: "ok" | "error" | "" = "") {
  const el = $("status");
  el.textContent = text;
  el.className = kind;
}

async function gateway<T>(path: string, body: unknown): Promise<{ status: number; data: T }> {
  if (!settings) throw new Error("Configure the gateway first");
  const response = await fetch(new URL(path, settings.gatewayUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${settings.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}

interface DiffResponse {
  currentVersion: string | null;
  suggestedVersion: string;
  requiredBump: string;
  breaking: string[];
  summary: string;
  isEmpty: boolean;
  problems: string[];
  error?: string;
}

interface PublishResponse {
  version?: string;
  branch?: string;
  statusUrl?: string;
  error?: string;
  problems?: string[];
  suggestedVersion?: string;
}

async function review(result: Extract<ToUi, { type: "scan-result" }>) {
  scan = { manifest: result.manifest, previews: result.previews };
  const m = result.manifest;
  $("stats").textContent = `${m.components.length} components · ${m.tokens.length} tokens · ${m.textStyles?.length ?? 0} text styles`;
  $("warnings").textContent = result.warnings.join("\n");
  status("Comparing with the published version…");
  const { status: code, data } = await gateway<DiffResponse>("/api/design-system/diff", { manifest: m });
  if (code !== 200) {
    status(data.error ?? `Gateway error ${code}`, "error");
    $("problems").textContent = (data.problems ?? []).join("\n");
    return;
  }
  status("");
  $("summary").textContent = data.summary;
  $("problems").textContent = data.problems.join("\n");
  ($("version") as HTMLInputElement).value = data.suggestedVersion;
  $("bump").textContent = data.currentVersion
    ? `Current version ${data.currentVersion}. These changes need at least a ${data.requiredBump} release.${data.breaking.length ? " Breaking changes will hide removed fields in Contentful." : ""}`
    : "First release.";
  ($("publish-button") as HTMLButtonElement).disabled = data.isEmpty || data.problems.length > 0;
  show("review");
}

async function publish() {
  if (!scan) return;
  const button = $("publish-button") as HTMLButtonElement;
  button.disabled = true;
  status("Publishing…");
  const manifest = {
    ...scan.manifest,
    version: ($("version") as HTMLInputElement).value.trim(),
    changelog: ($("changelog") as HTMLTextAreaElement).value.trim(),
    publishedAt: new Date().toISOString(),
  };
  try {
    const { status: code, data } = await gateway<PublishResponse>("/api/design-system/publish", {
      manifest,
      previews: scan.previews,
    });
    if (code === 202) {
      status(`Published ${data.version}. An agent is building it in Storybook on ${data.branch}; a PR will follow.`, "ok");
      post({ type: "notify", message: `Design system ${data.version} published` });
      return;
    }
    if (data.suggestedVersion) ($("version") as HTMLInputElement).value = data.suggestedVersion;
    status([data.error, ...(data.problems ?? [])].filter(Boolean).join("\n"), "error");
  } catch (error) {
    status(String(error), "error");
  }
  button.disabled = false;
}

window.onmessage = (event: MessageEvent<{ pluginMessage?: ToUi }>) => {
  const message = event.data.pluginMessage;
  if (!message) return;
  switch (message.type) {
    case "settings":
      settings = message.settings;
      $("file").textContent = message.fileName;
      if (settings) {
        const form = $("settings-form") as HTMLFormElement;
        (form.elements.namedItem("gatewayUrl") as HTMLInputElement).value = settings.gatewayUrl;
        (form.elements.namedItem("token") as HTMLInputElement).value = settings.token;
      }
      show(settings ? "scan" : "settings");
      break;
    case "scan-result":
      ($("scan-button") as HTMLButtonElement).disabled = false;
      review(message).catch((error: unknown) => status(String(error), "error"));
      break;
    case "error":
      ($("scan-button") as HTMLButtonElement).disabled = false;
      status(message.message, "error");
      break;
  }
};

$("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(event.target as HTMLFormElement);
  post({
    type: "save-settings",
    settings: { gatewayUrl: String(data.get("gatewayUrl")), token: String(data.get("token")) },
  });
});
$("edit-settings").addEventListener("click", () => show("settings"));
$("scan-button").addEventListener("click", () => {
  ($("scan-button") as HTMLButtonElement).disabled = true;
  status("Scanning…");
  post({ type: "scan" });
});
$("publish-button").addEventListener("click", () => void publish());

post({ type: "init" });
