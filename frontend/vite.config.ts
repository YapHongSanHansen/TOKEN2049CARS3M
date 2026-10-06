import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// /api -> carsem-api, /agent -> the agent service. Same origin for the browser.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // "@/..." -> src/ (the shadcn-style import path used by components/ui).
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:4021", changeOrigin: true, rewrite: path => path.replace(/^\/api/, "") },
      "/agent": { target: "http://localhost:4031", changeOrigin: true, rewrite: path => path.replace(/^\/agent/, "") },
    },
  },
});
