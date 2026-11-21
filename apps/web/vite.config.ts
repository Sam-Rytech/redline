import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// The BLAZE banner must carry these in any production build.
const BANNER_VARS = ["VITE_BLAZE_SLIDES_URL", "VITE_BLAZE_TOKEN_ADDRESS"];

// In development, /api goes to the mock API (pnpm dev:mock). In production Vercel rewrites it.
export default defineConfig(({ command, mode }) => {
  if (command === "build" && mode === "production") {
    const env = { ...loadEnv(mode, process.cwd()), ...process.env };
    const missing = BANNER_VARS.filter((k) => !env[k]);
    if (missing.length) throw new Error(`BLAZE banner: set ${missing.join(" and ")} (see .env.example).`);
  }
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: { "/api": `http://localhost:${process.env.MOCK_PORT ?? 8787}` },
    },
  };
});
