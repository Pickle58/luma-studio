// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
// Note that this config is unrelated to the Vercel Edge Runtime and is also required when running locally.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: "https://a9bb71c0923f158b0c30b6e84656f679@o4510165860155392.ingest.us.sentry.io/4511372989300736",

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: 1,

  // Stream gen_ai.* spans as they are produced. SDK >= 10.53.0.
  streamGenAiSpans: true,

  integrations: [
    // Vercel AI SDK auto-instrumentation for Edge runtime calls. Prompt/output
    // capture remains OFF; opt in per-call via `experimental_telemetry`.
    Sentry.vercelAIIntegration(),
  ],

  // Enable logs to be sent to Sentry
  enableLogs: true,

  // Enable sending user PII (Personally Identifiable Information)
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  sendDefaultPii: true,
});
