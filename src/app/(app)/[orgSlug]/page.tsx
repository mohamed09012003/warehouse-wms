import { getDashboardSummary } from "@/modules/tenancy";
import { tenantContextOrRedirect } from "@/server/auth/guards";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/primitives/card";

export const metadata = { title: "Dashboard · WMS" };

export default async function DashboardPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await tenantContextOrRedirect(orgSlug);
  const summary = await getDashboardSummary(ctx);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Organization</CardDescription>
            <CardTitle>{summary.organizationName}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Your role</CardDescription>
            <CardTitle>{summary.roleName}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Active members</CardDescription>
            <CardTitle>{summary.memberCount}</CardTitle>
          </CardHeader>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Foundation ready</CardTitle>
          <CardDescription>
            Warehouse, products, inventory, orders, picking, packing and integrations arrive in later phases.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">Use the sidebar to see the planned areas.</CardContent>
      </Card>
    </div>
  );
}
