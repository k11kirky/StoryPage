import type { StageResult, VerifyResult } from "@storypage/agents";
import type { ReleaseTarget } from "@storypage/contentful";
import type { DesignSystemManifest, Registry } from "@storypage/schema";
import type { BuildReport } from "./stages/build.js";
import type { ContentReport } from "./stages/content.js";
import type { ReviewReport } from "./stages/review.js";

export interface StageCost {
  stage: string;
  costUsd: number;
  turns: number;
}

const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "_None._");

export function buildBody(input: {
  manifest: DesignSystemManifest;
  diffSummary: string;
  buildReport: BuildReport | null;
  buildSummary: string;
  reviews: ReviewReport[];
  verify: VerifyResult;
  costs: StageCost[];
  changedFiles: string;
}): string {
  const { manifest, buildReport, verify } = input;
  const review = input.reviews.at(-1);
  const failed = verify.steps.find((s) => !s.passed);
  const sections = [
    `## Design system ${manifest.version}`,
    "",
    `Published from Figma file **${manifest.source.figmaFileName}** by ${manifest.publishedBy.name}.`,
    manifest.changelog ? `\n> ${manifest.changelog.split("\n").join("\n> ")}` : "",
    "",
    input.diffSummary,
    "",
    "## Build agent",
    "",
    buildReport
      ? [
          "| Component | Status | Notes |",
          "|---|---|---|",
          ...buildReport.components.map((c) => `| ${c.name} | ${c.status} | ${c.notes.replace(/\n/g, " ").replace(/\|/g, "\\|")} |`),
          "",
          "**Judgment calls**",
          list(buildReport.judgmentCalls),
          "",
          "**Unresolved**",
          list(buildReport.unresolved),
        ].join("\n")
      : input.buildSummary,
    "",
    "## Design review agent",
    "",
    review
      ? [
          `**${review.verdict === "approve" ? "✅ Approved" : "⚠️ Changes requested"}** after ${input.reviews.length} round(s). ${review.summary}`,
          "",
          list(review.findings.map((f) => `**${f.severity}** · ${f.component}: ${f.issue}${f.evidence ? ` _(${f.evidence})_` : ""}`)),
        ].join("\n")
      : "_No review ran._",
    "",
    "## Verification",
    "",
    verify.passed
      ? "✅ Typecheck, contract tests and Storybook build pass."
      : `❌ \`${failed?.step}\` fails. Do not merge until fixed:\n\n\`\`\`\n${failed?.output ?? ""}\n\`\`\``,
    "",
    "## After merge",
    "",
    "The release workflow deploys Storybook, then the content agent migrates Contentful in a cloned",
    `environment \`ds-${manifest.version.replace(/\./g, "-")}\` and moves the \`master\` alias once every page validates.`,
    "",
    `<details><summary>Changed files</summary>\n\n\`\`\`\n${input.changedFiles}\n\`\`\`\n</details>`,
    "",
    `_Agent cost: ${input.costs.map((c) => `${c.stage} $${c.costUsd.toFixed(2)} (${c.turns} turns)`).join(", ") || "none"}_`,
  ];
  return `${sections.join("\n")}\n`;
}

export function contentBody(input: {
  registry: Registry;
  target: ReleaseTarget;
  result: StageResult<ContentReport>;
  promoted: boolean;
}): string {
  const { result, target } = input;
  const report = result.output;
  return [
    `## Contentful release: design-system@${input.registry.version}`,
    "",
    input.promoted
      ? `✅ \`${target.environment}\` is live${target.previousEnvironment ? ` (rollback: point the alias back at \`${target.previousEnvironment}\`)` : ""}.`
      : `❌ Not promoted. The live environment is unchanged; \`${target.environment}\` holds the work so far.`,
    "",
    report?.summary ?? result.summary,
    "",
    "**Content migrated**",
    list((report?.migrated ?? []).map((m) => `${m.contentType}.${m.from} → ${m.to ?? "(removed)"}: ${m.entries} entries. ${m.how}`)),
    "",
    "**Needs an editor**",
    list(report?.needsHumanAttention ?? []),
    "",
    `_Agent cost: $${result.costUsd.toFixed(2)} (${result.turns} turns)_`,
    "",
  ].join("\n");
}
