import { authClient } from "./auth-client";
import { getMe } from "./api";

/**
 * Makes sure the session has an active organization.
 *
 * A session can exist without one — first sign-in, or a workspace that was
 * left — and every scoped endpoint refuses without it. Both the office and the
 * admin panel need this, and having it in one place is why the panel does not
 * quietly 403 the way it did when only the office did the work.
 *
 * Returns false when the person belongs to no workspace at all.
 */
export async function ensureActiveOrganization(): Promise<boolean> {
  const me = await getMe();
  if (me.activeOrgId) return true;

  const first = me.organizations[0];
  if (!first) return false;

  await authClient.organization.setActive({ organizationId: first.orgId });
  return true;
}
