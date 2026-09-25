import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { existsSync, renameSync, rmSync } from "fs";
import { resolve } from "path";

const app = process.env.APP;
const ALLOWED_APPS = new Set(["get-me", "issue-write", "pr-edit", "pr-write"]);

if (!app || !ALLOWED_APPS.has(app)) {
  throw new Error("APP must be one of the known UI application names");
}

const outDir = resolve(__dirname, "../pkg/github/ui_dist");
const appsRoot = resolve(__dirname, "src/apps");

function flattenOutput(): Plugin {
  return {
    name: "flatten-output",
    enforce: "post",
    closeBundle() {
      const nested = resolve(appsRoot, app, "index.html");
      const flat = resolve(outDir, `${app}.html`);
      if (!nested.startsWith(appsRoot + "/") && !nested.startsWith(appsRoot + "\\")) {
        throw new Error("flatten-output: input path escaped apps root");
      }
      if (!flat.startsWith(outDir + "/") && !flat.startsWith(outDir + "\\")) {
        throw new Error("flatten-output: output path escaped UI output root");
      }
      if (!existsSync(nested)) {
        throw new Error(
          `flatten-output: expected built HTML at ${nested} for app "${app}" but it was not emitted`,
        );
      }
      renameSync(nested, flat);
      rmSync(resolve(outDir, "src"), { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), viteSingleFile(), flattenOutput()],
  build: {
    outDir,
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(appsRoot, app, "index.html"),
    },
  },
});
