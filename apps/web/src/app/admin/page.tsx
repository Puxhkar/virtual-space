"use client";

import { useSession } from "@/lib/auth-client";
import { OfficeEditor } from "@/components/admin/OfficeEditor";
import { SignIn } from "@/components/SignIn";

/**
 * The admin panel.
 *
 * Access is enforced by the server on publish — this only decides what to
 * render. A member who reaches this page can look, but their save is refused
 * (CLAUDE.md §12: never trust the client for authorization).
 */
export default function AdminPage() {
  const { data: session, isPending, refetch } = useSession();

  if (isPending) {
    return (
      <div className="grid h-dvh place-items-center">
        <p className="text-sm text-neutral-500">Checking your session…</p>
      </div>
    );
  }

  if (!session) return <SignIn onSignedIn={() => void refetch()} />;

  return <OfficeEditor />;
}
