import { redirect } from "next/navigation";
import { listUserOrganizations } from "@/modules/tenancy";
import { getSessionUserId } from "@/server/auth/session";

// Entry point: send the user to their first organization (or to login).
export default async function Home() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const organizations = await listUserOrganizations(userId);
  if (organizations.length > 0) redirect(`/${organizations[0].slug}`);

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <p className="text-muted-foreground">Your account is not a member of any organization yet.</p>
    </main>
  );
}
