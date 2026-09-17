import type { NextConfig } from "next";
const config: NextConfig = {
  serverExternalPackages: ["pdf-parse", "mammoth", "pg", "exceljs"],
  poweredByHeader: false,
  // OAuth callback URLs contain short-lived codes; never print incoming URLs.
  logging: { incomingRequests: false, browserToTerminal: false },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};
export default config;
