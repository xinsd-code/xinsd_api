import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module, exclude from webpack bundling
  serverExternalPackages: ['better-sqlite3'],
};

export default nextConfig;
