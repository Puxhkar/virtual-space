import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { db } from "./db/client.js";
import * as schema from "./db/schema.js";
import { env, googleEnabled } from "./env.js";

/**
 * Organizations, members and invitations are owned by the organization plugin
 * (decision 007). We do not define parallel tables for them.
 *
 * The options are inline rather than in a separate object because Better Auth
 * infers the session shape from the plugin list at this call site — extracting
 * them loses `activeOrganizationId` from the type.
 */
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),

  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.WEB_ORIGIN],

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
  },

  socialProviders: googleEnabled
    ? {
        google: {
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
        },
      }
    : {},

  plugins: [
    organization({
      // A person may belong to several organizations, but creation is capped
      // so a signup cannot spray them. Raised when self-serve lands.
      organizationLimit: 5,
      creatorRole: "owner",
      membershipLimit: 100,
    }),
  ],

  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },

  advanced: {
    database: {
      // Better Auth generates nanoid-style ids by default. Our shared contracts
      // brand every id as a uuid, so we override rather than weaken the
      // contract (decision 008).
      generateId: () => crypto.randomUUID(),
    },
  },
});

export type Auth = typeof auth;
export type Session = Auth["$Infer"]["Session"];
