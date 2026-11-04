// Loads and validates the environment. Secrets come from the gitignored `.env`;
// keys are referenced here so the backend never embeds a secret value.

import "dotenv/config";
import path from "node:path";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Dashboard cannot start: dashboard/configuration — required environment variable ${name} is empty`);
  }
  return value;
}

export const config = {
  dataDir: process.env.DASHBOARD_DATA_DIR || (process.env.NODE_ENV === "production" ? "/app/data" : path.resolve(".data")),
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 14141),
  dashboardToken: process.env.DASHBOARD_TOKEN || "",
  sessionSecret: required("SESSION_SECRET"),

  oidc: {
    issuer: required("OIDC_ISSUER"),
    clientId: required("OIDC_CLIENT_ID"),
    clientSecret: required("OIDC_CLIENT_SECRET"),
    redirectUri: process.env.OIDC_REDIRECT_URI || "http://127.0.0.1:14141/auth/callback",
    requiredGroup: process.env.OIDC_REQUIRED_GROUP || "trance-0/app-agent",
    adminGroup: process.env.OIDC_ADMIN_GROUP || "trance-0/admin-agent",
  },

  openclaw: {
    endpoint: process.env.OPENCLAW_ENDPOINT || "http://127.0.0.1:18789",
    token: process.env.OPENCLAW_TOKEN || "",
    agent: process.env.OPENCLAW_AGENT || "dashboard-host",
    streamToken: process.env.OPENCLAW_STREAM_TOKEN || "",
    activityDir: process.env.OPENCLAW_ACTIVITY_DIR || "",
  },

  astrbot: {
    endpoint: process.env.ASTRBOT_ENDPOINT || "http://127.0.0.1:6185",
    username: process.env.ASTRBOT_USERNAME || "",
    password: process.env.ASTRBOT_PASSWORD || "",
  },

  jenkins: {
    endpoint: process.env.JENKINS_ENDPOINT || "http://127.0.0.1:8081",
    user: process.env.JENKINS_USER || "",
    token: process.env.JENKINS_TOKEN || "",
  },
};

// True only when a mutating-token has been configured. The dashboard refuses
// mutating endpoints without one, because any local process can reach loopback.
export const hasDashboardToken = config.dashboardToken.length > 0;
