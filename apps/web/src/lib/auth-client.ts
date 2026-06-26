"use client";

import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";
import { API_URL } from "./env";

/**
 * The auth client talks to the API server, not to Next.
 *
 * Sessions are cookies, and the API is on a different port in development, so
 * every call must send credentials. The server allows exactly one origin.
 */
export const authClient = createAuthClient({
  baseURL: API_URL,
  plugins: [organizationClient()],
  fetchOptions: { credentials: "include" },
});

export const { signIn, signUp, signOut, useSession } = authClient;
