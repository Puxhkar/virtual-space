import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@vo/shared"],
  // We maintain CLAUDE.md ourselves at the repo root. Next 16 otherwise
  // writes its own into apps/web, which competes with it.
  agentRules: false,
};

export default config;
