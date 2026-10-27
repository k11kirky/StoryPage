/** Bundles the plugin: dist/code.js (main thread) and dist/ui.html (UI with inlined script). */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { build, context, type BuildOptions } from "esbuild";

const watch = process.argv.includes("--watch");
mkdirSync("dist", { recursive: true });

const code: BuildOptions = {
  entryPoints: ["src/code.ts"],
  bundle: true,
  outfile: "dist/code.js",
  target: "es2017",
  format: "iife",
  logLevel: "info",
};

const ui: BuildOptions = {
  entryPoints: ["src/ui.ts"],
  bundle: true,
  write: false,
  target: "es2020",
  format: "iife",
  logLevel: "info",
  plugins: [
    {
      name: "inline-ui",
      setup(b) {
        b.onEnd((result) => {
          const script = result.outputFiles?.[0]?.text ?? "";
          const html = readFileSync("src/ui.html", "utf8").replace("</body>", `<script>${script}</script>\n  </body>`);
          writeFileSync("dist/ui.html", html);
        });
      },
    },
  ],
};

if (watch) {
  await (await context(code)).watch();
  await (await context(ui)).watch();
} else {
  await Promise.all([build(code), build(ui)]);
}
