import { redirect } from "next/navigation";
import { getSessionUserId } from "@/server/auth/session";
import { LoginForm } from "@/ui/features/auth/LoginForm";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/primitives/card";

export const metadata = { title: "Sign in · WMS" };

export default async function LoginPage() {
  if (await getSessionUserId()) redirect("/");
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Warehouse Management System</CardTitle>
          <CardDescription>Sign in to continue</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm />
        </CardContent>
      </Card>
    </main>
  );
}
