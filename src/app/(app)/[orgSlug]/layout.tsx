import { tenantContextOrRedirect } from "@/server/auth/guards";
import { getDashboardSummary } from "@/modules/tenancy";
import { Header } from "@/ui/shared/Header";
import { Sidebar } from "@/ui/shared/Sidebar";

// Every page under /[orgSlug] is gated here: the session must belong to an active member
// of this organization, verified server-side against the database.
export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const ctx = await tenantContextOrRedirect(orgSlug);
  const organization = { name: (await getDashboardSummary(ctx)).organizationName };

  return (
    <div className="flex min-h-screen">
      <Sidebar orgSlug={ctx.organizationSlug} orgName={organization.name} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header orgName={organization.name} roleName={ctx.roleName} />
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
