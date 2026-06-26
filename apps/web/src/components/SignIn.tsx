"use client";

import { useState } from "react";
import { signIn } from "@/lib/auth-client";

/**
 * Sign-in.
 *
 * Errors say what went wrong and what to do next, and the form stays usable
 * while a request is in flight rather than freezing (CLAUDE.md §20, §21).
 */
export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const result = await signIn.email({ email, password });

    setBusy(false);
    if (result.error) {
      setError(
        result.error.status === 401
          ? "That email and password do not match."
          : (result.error.message ??
              "Could not sign in. Check your connection and try again."),
      );
      return;
    }
    onSignedIn();
  }

  return (
    <div className="grid h-dvh place-items-center px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-neutral-800 bg-neutral-900/60 p-6"
      >
        <div>
          <h1 className="text-lg font-medium tracking-tight">Virtual Office</h1>
          <p className="mt-1 text-sm text-neutral-400">
            Sign in to enter your workspace.
          </p>
        </div>

        <label className="block space-y-1">
          <span className="text-xs text-neutral-400">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus-visible:border-neutral-500"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs text-neutral-400">Password</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus-visible:border-neutral-500"
          />
        </label>

        {error && (
          <p
            role="alert"
            className="rounded-md border border-red-900 bg-red-950/60 px-3 py-2 text-sm text-red-200"
          >
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 disabled:opacity-60"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <p className="text-center text-xs text-neutral-600">
          Development seed: ada@example.com / development-password-123
        </p>
      </form>
    </div>
  );
}
