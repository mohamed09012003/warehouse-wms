import { logoutAction } from "@/app/login/actions";
import { Badge } from "@/ui/primitives/badge";
import { Button } from "@/ui/primitives/button";

export function Header({ orgName, roleName }: { orgName: string; roleName: string }) {
  return (
    <header className="flex h-14 items-center justify-between border-b px-4">
      <div className="flex items-center gap-2">
        <span className="font-medium">{orgName}</span>
        <Badge variant="secondary">{roleName}</Badge>
      </div>
      <form action={logoutAction}>
        <Button type="submit" variant="outline" size="sm">
          Sign out
        </Button>
      </form>
    </header>
  );
}
