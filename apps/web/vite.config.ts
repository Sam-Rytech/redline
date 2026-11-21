import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development, /api goes to the mock API (pnpm dev:mock). In production Vercel rewrites it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": `http://localhost:${process.env.MOCK_PORT ?? 8787}` },
  },
});
