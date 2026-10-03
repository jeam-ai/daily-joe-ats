import { spawn } from "node:child_process";
const env = {
  ...process.env,
  PERSISTENCE_PROVIDER: "local",
  LOCAL_DATABASE_FILE: "final-system-qa-20261003.sqlite",
  GOOGLE_ALLOWED_EMAIL: "admin@example.invalid",
  OFFICIAL_CAREERS_EMAIL: "careers@example.invalid",
  GOOGLE_CLIENT_ID: "test",
  GOOGLE_CLIENT_SECRET: "test",
  GOOGLE_REDIRECT_URI: "http://localhost:3004/api/auth/callback",
  APP_ORIGIN: "http://localhost:3004",
  SESSION_SECRET: "s".repeat(40),
  TOKEN_ENCRYPTION_KEY: "ab".repeat(32),
  DATABASE_URL: "",
  AIVEN_DATABASE_URL: "",
  DATABASE_POOL_URL: "",
  GEMINI_API_KEY: "",
  GOOGLE_SHEETS_ID: "",
  CRON_SECRET: "final-qa-scheduler-only",
};
const mode = process.argv[2] === "start" ? "start" : "dev";
const child = spawn(
  process.execPath,
  [
    "--use-system-ca",
    "node_modules/next/dist/bin/next",
    mode,
    "--hostname",
    "127.0.0.1",
    "--port",
    "3004",
  ],
  { env, stdio: "inherit", windowsHide: true },
);
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code) => {
  process.exitCode = code || 0;
});
