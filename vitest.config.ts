import { defineConfig } from "vitest/config";
import path from "node:path";

// Isolamento: só rodamos módulos puros (sem I/O, sem React, sem TanStack Start).
// Nada de jsdom — mantém a suíte < 1s.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "src/lib/evolution/state.server.ts",
        "src/lib/evolution/qr.server.ts",
        "src/lib/oauth-state.server.ts",
      ],
    },
  },
});
