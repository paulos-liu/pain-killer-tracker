import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  accountId: "cdd42ea0bb5a1f7c375dff5fa8f57171",
  worker: {
    name: "pain-medicine-log",
    compatibilityDate: "2026-11-09",
    entrypoint: "./src/index.js",
    assets: {
      runWorkerFirst: ["/api/*"]
    },
    observability: {
      enabled: true,
      redactQueryString: true,
      logs: { enabled: true, headSamplingRate: 1 },
      traces: { enabled: true, headSamplingRate: 1 }
    },
    env: {
      DB: bindings.d1({ name: "pain-medicine-log", id: "b22c535c-aee0-46fa-a627-8f62dc248b10" }),
      ASSETS: bindings.assets()
    }
  }
});
