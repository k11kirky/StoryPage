import type { DesignSystemManifestInput, Placement, PropKind, PropSpec } from "@storypage/schema";
import {
  resolveSelection,
  toCamelCase,
  type ComponentDraft,
  type ComponentSelection,
  type ResolvedSelection,
  type Tier,
} from "@storypage/schema/figma";
import type { FromUi, Settings, ToUi } from "./messages";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const post = (message: FromUi) => parent.postMessage({ pluginMessage: message }, "*");
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

/** The tiers, in designers' words. */
const TIERS: { value: Tier; label: string; help: string }[] = [
  { value: "off", label: "Not published", help: "Stays in Figma only." },
  { value: "none", label: "Storybook only", help: "Built as code for other components to use. Not in Contentful." },
  { value: "block", label: "Content block", help: "Editors can place it inside other components (e.g. a card in a grid)." },
  { value: "section", label: "Page section", help: "Editors can add it to pages." },
];
const tierLabel = (tier: Tier) => TIERS.find((t) => t.value === tier)!.label;

const KIND_LABELS: Record<PropKind, string> = {
  text: "Short text",
  longText: "Paragraph",
  richText: "Formatted text",
  link: "Link",
  image: "Image",
  number: "Number",
  boolean: "On/off",
  enum: "Choice",
  slot: "Components",
};
/** Kinds a text property can be switched between. */
const TEXT_KINDS: PropKind[] = ["text", "longText", "richText", "link"];
/** Kinds designers can add as extra fields (Figma has no property for them). */
const EXTRA_KINDS: PropKind[] = ["image", "link", "richText", "longText", "text"];

let settings: Settings | null = null;
let base: DesignSystemManifestInput | null = null;
let drafts: ComponentDraft[] = [];
let selections: Record<string, ComponentSelection> = {};
let suggestions: Record<string, Placement> = {};
let scanWarnings: string[] = [];
let resolved: ResolvedSelection = { components: [], included: [], warnings: [] };
let pendingManifest: DesignSystemManifestInput | null = null;
let previews: Record<string, string> = {};

function show(section: "settings" | "scan" | "picker" | "review") {
  $("settings").hidden = section !== "settings";
  $("scan").hidden = section === "settings";
  $("picker").hidden = section !== "picker";
  $("review").hidden = section !== "review";
}

function status(text: string, kind: "ok" | "error" | "" = "") {
  const node = $("status");
  node.textContent = text;
  node.className = kind;
}

// ---------------------------------------------------------------------------
// Picker
// ---------------------------------------------------------------------------

function select(draft: ComponentDraft, change: (s: ComponentSelection) => ComponentSelection) {
  const current: ComponentSelection = selections[draft.figmaKey] ?? { tier: "off" };
  const next = change(structuredClone(current));
  selections[draft.figmaKey] = next;
  post({ type: "save-selection", nodeId: draft.figmaNodeId!, selection: next });
  render();
}

function fieldRow(draft: ComponentDraft, prop: PropSpec, extra: boolean): HTMLTableRowElement {
  const selection = selections[draft.figmaKey];
  const override = selection?.props?.[prop.name];
  const kind = override?.kind ?? prop.kind;
  const editable = override?.editable ?? prop.editable;

  let kindCell: Node;
  if (!extra && TEXT_KINDS.includes(prop.kind)) {
    const kindSelect = el("select");
    for (const k of TEXT_KINDS) kindSelect.append(el("option", { value: k, textContent: KIND_LABELS[k], selected: k === kind }));
    kindSelect.onchange = () =>
      select(draft, (s) => ({ ...s, props: { ...s.props, [prop.name]: { ...s.props?.[prop.name], kind: kindSelect.value as PropKind } } }));
    kindCell = kindSelect;
  } else {
    const detail =
      prop.kind === "enum" ? `: ${(prop.options ?? []).join(", ")}` : prop.kind === "slot" ? `: ${(prop.allowedComponents ?? []).join(", ") || "any block"}` : "";
    kindCell = el("span", { className: "muted", textContent: `${KIND_LABELS[kind]}${detail}` });
  }

  const checkbox = el("input", { type: "checkbox", checked: editable, title: "Editors fill this in" });
  checkbox.onchange = () =>
    select(draft, (s) => ({ ...s, props: { ...s.props, [prop.name]: { ...s.props?.[prop.name], editable: checkbox.checked } } }));

  const remove = extra
    ? el("button", {
        className: "small",
        textContent: "Remove",
        onclick: () => select(draft, (s) => ({ ...s, extraProps: (s.extraProps ?? []).filter((p) => p.name !== prop.name) })),
      })
    : "";
  return el(
    "tr",
    {},
    el("td", {}, prop.name),
    el("td", {}, kindCell),
    el("td", {}, el("label", { className: "inline" }, checkbox, "Editors fill in")),
    el("td", {}, remove),
  );
}

function fieldsEditor(draft: ComponentDraft): HTMLDetailsElement {
  const selection = selections[draft.figmaKey];
  const extras = selection?.extraProps ?? [];
  const table = el("table");
  for (const prop of draft.props) table.append(fieldRow(draft, prop, false));
  for (const prop of extras) table.append(fieldRow(draft, prop, true));

  const name = el("input", { placeholder: "New field, e.g. Background image" });
  const kind = el("select");
  for (const k of EXTRA_KINDS) kind.append(el("option", { value: k, textContent: KIND_LABELS[k] }));
  const add = el("button", {
    className: "small",
    textContent: "Add field",
    onclick: () => {
      const fieldName = toCamelCase(name.value);
      if (!fieldName) return;
      select(draft, (s) => ({
        ...s,
        extraProps: [...(s.extraProps ?? []).filter((p) => p.name !== fieldName), { name: fieldName, kind: kind.value as PropKind, required: false, editable: true }],
      }));
    },
  });
  const details = el(
    "details",
    {},
    el("summary", { textContent: `Content fields (${draft.props.length + extras.length}) — what editors fill in` }),
    table,
    el("div", { className: "row" }, name, kind, add),
  );
  details.open = openFields.has(draft.figmaKey);
  details.ontoggle = () => (details.open ? openFields.add(draft.figmaKey) : openFields.delete(draft.figmaKey));
  return details;
}
const openFields = new Set<string>();

function componentRow(draft: ComponentDraft): HTMLElement {
  const chosen = selections[draft.figmaKey]?.tier;
  const included = resolved.included.find((i) => i.name === draft.name);
  const effective = resolved.components.find((c) => c.name === draft.name)?.placement;

  // No choice yet: "Not published", or "Automatic" when a chosen component needs it.
  const tierSelect = el("select");
  tierSelect.append(el("option", { value: "", textContent: included && effective ? `Automatic: ${tierLabel(effective)}` : "Not published", selected: !chosen }));
  if (included || chosen === "off") {
    tierSelect.append(el("option", { value: "off", textContent: "Don't include", title: "Leave it out where possible", selected: chosen === "off" }));
  }
  for (const tier of TIERS.filter((t) => t.value !== "off")) {
    tierSelect.append(el("option", { value: tier.value, textContent: tier.label, title: tier.help, selected: tier.value === chosen }));
  }
  tierSelect.onchange = () => {
    if (tierSelect.value === "") {
      delete selections[draft.figmaKey];
      post({ type: "save-selection", nodeId: draft.figmaNodeId!, selection: null });
      render();
    } else {
      select(draft, (s) => ({ ...s, tier: tierSelect.value as Tier }));
    }
  };

  const hints: HTMLElement[] = [];
  if (included && effective) {
    hints.push(el("p", { className: "hint auto", textContent: `Included because ${included.reason}.` }));
  } else if (!chosen && suggestions[draft.figmaKey] && suggestions[draft.figmaKey] !== "none") {
    hints.push(el("p", { className: "hint", textContent: `Suggested: ${tierLabel(suggestions[draft.figmaKey]!)}` }));
  }

  const row = el(
    "div",
    { className: "component" },
    el(
      "div",
      { className: "row" },
      el("button", { className: "link grow", textContent: draft.name, title: "Show in Figma", onclick: () => post({ type: "select-node", nodeId: draft.figmaNodeId! }) }),
      el("span", { className: "muted", textContent: draft.variantCount > 1 ? `${draft.variantCount} variants` : "" }),
      tierSelect,
    ),
    ...hints,
  );
  if (effective === "section" || effective === "block") row.append(fieldsEditor(draft));
  return row;
}

function render() {
  resolved = resolveSelection(drafts, selections);
  const count = (tier: Placement) => resolved.components.filter((c) => c.placement === tier).length;
  $("summary").replaceChildren(
    el("div", {}, el("strong", { textContent: String(count("section")) }), "page sections in Contentful"),
    el("div", {}, el("strong", { textContent: String(count("block")) }), "content blocks in Contentful"),
    el("div", {}, el("strong", { textContent: String(resolved.components.length) }), "components in Storybook"),
  );
  $("picker-warnings").textContent = [...scanWarnings, ...resolved.warnings].join("\n");

  const query = ($("search") as HTMLInputElement).value.toLowerCase();
  const publishedOnly = ($("filter") as HTMLSelectElement).value === "published";
  const published = new Set(resolved.components.map((c) => c.name));
  const visible = drafts.filter(
    (d) => (!query || d.name.toLowerCase().includes(query) || d.category.toLowerCase().includes(query)) && (!publishedOnly || published.has(d.name)),
  );
  const categories = [...new Set(visible.map((d) => d.category))].sort();
  $("components").replaceChildren(
    ...categories.flatMap((category) => [
      el("h2", { textContent: category }),
      ...visible.filter((d) => d.category === category).map(componentRow),
    ]),
  );
  ($("continue") as HTMLButtonElement).disabled = resolved.components.length === 0;
}

function useSuggestions() {
  for (const draft of drafts) {
    if (!selections[draft.figmaKey] && suggestions[draft.figmaKey] === "section") {
      selections[draft.figmaKey] = { tier: "section" };
      post({ type: "save-selection", nodeId: draft.figmaNodeId!, selection: selections[draft.figmaKey]! });
    }
  }
  render();
}

// ---------------------------------------------------------------------------
// Review and publish
// ---------------------------------------------------------------------------

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
  error?: string;
  problems?: string[];
  suggestedVersion?: string;
}

function continueToReview() {
  if (!base) return;
  pendingManifest = { ...base, components: resolved.components };
  status("Exporting previews…");
  ($("continue") as HTMLButtonElement).disabled = true;
  post({
    type: "export-previews",
    components: resolved.components.map((c) => ({ name: c.name, nodeId: c.figmaNodeId! })),
  });
}

async function review(exportWarnings: string[]) {
  const manifest = pendingManifest!;
  const count = (tier: Placement) => resolved.components.filter((c) => c.placement === tier).length;
  $("stats").textContent =
    `${resolved.components.length} components to Storybook · ${count("section")} page sections and ${count("block")} content blocks to Contentful · ` +
    `${manifest.tokens.length} tokens · ${manifest.textStyles?.length ?? 0} text styles`;
  $("warnings").textContent = exportWarnings.join("\n");
  status("Comparing with the published version…");
  const { status: code, data } = await gateway<DiffResponse>("/api/design-system/diff", { manifest });
  ($("continue") as HTMLButtonElement).disabled = false;
  if (code !== 200) {
    status(data.error ?? `Gateway error ${code}`, "error");
    $("problems").textContent = (data.problems ?? []).join("\n");
    return;
  }
  status("");
  $("diff").textContent = data.summary;
  $("problems").textContent = data.problems.join("\n");
  ($("version") as HTMLInputElement).value = data.suggestedVersion;
  $("bump").textContent = data.currentVersion
    ? `Current version ${data.currentVersion}. These changes need at least a ${data.requiredBump} release.${data.breaking.length ? " Breaking changes keep existing content but hide what no longer applies." : ""}`
    : "First release.";
  ($("publish-button") as HTMLButtonElement).disabled = data.isEmpty || data.problems.length > 0;
  show("review");
}

async function publish() {
  if (!pendingManifest) return;
  const button = $("publish-button") as HTMLButtonElement;
  button.disabled = true;
  status("Publishing…");
  const manifest = {
    ...pendingManifest,
    version: ($("version") as HTMLInputElement).value.trim(),
    changelog: ($("changelog") as HTMLTextAreaElement).value.trim(),
    publishedAt: new Date().toISOString(),
  };
  try {
    const { status: code, data } = await gateway<PublishResponse>("/api/design-system/publish", { manifest, previews });
    if (code === 202) {
      status(`Published ${data.version}. Agents are building it in Storybook; a pull request will follow for review.`, "ok");
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

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

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
      base = message.manifest;
      drafts = message.drafts;
      selections = message.selections;
      suggestions = message.suggestions;
      scanWarnings = message.warnings;
      status("");
      render();
      show("picker");
      break;
    case "previews":
      previews = message.previews;
      review(message.warnings).catch((error: unknown) => status(String(error), "error"));
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
  post({ type: "save-settings", settings: { gatewayUrl: String(data.get("gatewayUrl")), token: String(data.get("token")) } });
});
$("edit-settings").addEventListener("click", () => show("settings"));
$("scan-button").addEventListener("click", () => {
  ($("scan-button") as HTMLButtonElement).disabled = true;
  status("Scanning components, variables and styles…");
  post({ type: "scan" });
});
$("search").addEventListener("input", render);
$("filter").addEventListener("change", render);
$("suggest").addEventListener("click", useSuggestions);
$("continue").addEventListener("click", continueToReview);
$("back").addEventListener("click", () => show("picker"));
$("publish-button").addEventListener("click", () => void publish());

post({ type: "init" });
