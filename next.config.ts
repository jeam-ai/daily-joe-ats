import type { NextConfig } from "next";
const config: NextConfig = {
  serverExternalPackages: [
    "@napi-rs/canvas",
    "pdf-parse",
    "mammoth",
    "pg",
    "exceljs",
    "tesseract.js",
  ],
  // pdf.js loads its canvas implementation through createRequire at runtime,
  // which cannot be discovered by automatic output tracing.
  outputFileTracingIncludes: {
    "/api/**": [
      "./node_modules/@napi-rs/canvas/**/*",
      "./node_modules/@napi-rs/canvas-linux-x64-gnu/**/*",
      // PDF.js loads its fake worker through a runtime import that tracing
      // cannot infer from pdf.mjs. Without it, deployed PDF text extraction
      // fails even though the parser itself is present.
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
    ],
  },
  // Local operational state and temporary credentials must never be copied
  // into a production function bundle.
  outputFileTracingExcludes: {
    "/*": ["./.data/**/*"],
  },
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
