import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Los tests del portal web (web/) tienen su propia configuración.
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/support/offline-network.ts"]
  }
});
