import "dotenv/config";
import * as z from "zod";

/**
 * Environment is parsed once, at boot, and the process refuses to start if it
 * is wrong. A missing secret should be a startup crash with a clear message,
 * never an undefined that surfaces as a 500 an hour later (CLAUDE.md §21).
 */

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.url(),

  DATABASE_URL: z.url(),

  // 32 bytes base64 is 44 chars. Anything shorter is a placeholder.
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.url(),

  // Empty string means "not configured", which is valid — Google sign-in is
  // optional and email sign-in works without it.
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),

  // Also optional. Without these the office works, with voice and video
  // reporting themselves as unavailable rather than failing at connect time.
  LIVEKIT_URL: z.string().default(""),
  LIVEKIT_API_KEY: z.string().default(""),
  LIVEKIT_API_SECRET: z.string().default(""),
});

function loadEnv() {
  const parsed = EnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    // Not a thrown error: a stack trace here is noise. The operator needs the
    // list of what is wrong, then a clean exit.
    console.error(`Invalid environment.\n${issues}\n`);
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();

/** True when all three LiveKit values are present. */
export const livekitConfigured =
  env.LIVEKIT_URL !== "" &&
  env.LIVEKIT_API_KEY !== "" &&
  env.LIVEKIT_API_SECRET !== "";

/** True when both Google credentials are present. */
export const googleEnabled =
  env.GOOGLE_CLIENT_ID !== "" && env.GOOGLE_CLIENT_SECRET !== "";
