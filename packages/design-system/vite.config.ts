/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  css: { modules: { localsConvention: "camelCaseOnly" } },
  test: {
    environment: "jsdom",
    css: { modules: { classNameStrategy: "non-scoped" } },
  },
});
