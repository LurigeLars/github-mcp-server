import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { existsSync, renameSync, rmSync } from "fs";
import { resolve } from "path";

const appName = process.env.APP;
const appsRoot = resolve(__dirname, "src/apps");
const outDir = resolve(__dirname, "../pkg/github/ui_dist");

function appPaths(name: string | undefined) {
  switch (name) {
    case "get-me":
      return { input: resolve(appsRoot, "get-me", "index.html"), output: resolve(outDir, "get-me.html") };
    case "issue-write":
      return { input: resolve(appsRoot, "issue-write", "index.html"), output: resolve(outDir, "issue-write.html") };
    case "pr-edit":
      return { input: resolve(appsRoot, "pr-edit", "index.html"), output: resolve(outDir, "pr-edit.html") };
    case "pr-write":
      return { input: resolve(appsRoot, "pr-write", "index.html"), output: resolve(outDir, "pr-write.html") };
    default:
      throw new Error("APP must be one of the known UI application names");
  }
}

const app = appPaths(appName);

function flattenOutput(): Plugin {
  return {
    name: "flatten-output",
    enforce: "post",
    closeBundle() {
      if (!existsSync(app.input)) {
        throw new Error("flatten-output: expected built HTML was not emitted");
      }
      renameSync(app.input, app.output);
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
      input: app.input,
    },
  },
});
