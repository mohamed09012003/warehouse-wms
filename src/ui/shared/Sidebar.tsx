"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { NAV_ITEMS } from "./nav";

export function Sidebar({ orgSlug, orgName }: { orgSlug: string; orgName: string }) {
  const pathname = usePathname();
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r bg-muted/30 md:flex">
      <div className="border-b px-4 py-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">WMS</div>
        <div className="truncate font-semibold">{orgName}</div>
      </div>
      <nav className="flex-1 space-y-1 p-2" aria-label="Main">
        {NAV_ITEMS.map((item) => {
          const href = item.path ? `/${orgSlug}/${item.path}` : `/${orgSlug}`;
          const active = item.path ? pathname.startsWith(href) : pathname === href;
          return (
            <Link
              key={item.label}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "block rounded-md px-3 py-2 text-sm hover:bg-accent",
                active && "bg-accent font-medium",
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
