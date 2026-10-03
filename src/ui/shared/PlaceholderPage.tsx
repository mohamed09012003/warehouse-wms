import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/primitives/card";

export function PlaceholderPage({ title, phase }: { title: string; phase: string }) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <Card>
        <CardHeader>
          <CardTitle>Not implemented yet</CardTitle>
          <CardDescription>This area is planned for {phase}.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          The navigation entry exists to establish the application structure.
        </CardContent>
      </Card>
    </div>
  );
}
