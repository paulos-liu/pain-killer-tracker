import { cpSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

const siteFiles = ["index.html", "app.js", "logic.js", "styles.css"];

function restoreSiteEntry() {
  if (existsSync("index.html.hold")) renameSync("index.html.hold", "index.html");
}

export default defineConfig({
  server: { port: 8788, strictPort: true },
  plugins: [
    {
      name: "classic-site-assets",
      apply: "build",
      buildApp: {
        order: "pre",
        async handler() {
          mkdirSync("public", { recursive: true });
          for (const file of siteFiles) {
            const source = file === "index.html" && !existsSync(file) ? "index.html.hold" : file;
            cpSync(source, `public/${file}`);
          }
          if (existsSync("index.html")) renameSync("index.html", "index.html.hold");
          process.once("exit", restoreSiteEntry);
        }
      }
    },
    cloudflare(),
    {
      name: "restore-site-entry",
      apply: "build",
      buildApp: {
        order: "post",
        async handler() {
          restoreSiteEntry();
        }
      }
    }
  ]
});
