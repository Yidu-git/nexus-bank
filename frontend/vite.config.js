import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, forward /api calls to the Flask backend.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:5000" } },
});
