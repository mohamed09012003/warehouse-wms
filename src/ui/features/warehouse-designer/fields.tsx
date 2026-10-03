"use client";

import { useId, useState } from "react";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";

/** Whole-number field (millimetres by default). Commits as soon as the text is a valid integer ≥ min. */
export function NumberField({
  label,
  value,
  onCommit,
  min = 0,
  unit = "mm",
  disabled,
  className,
}: {
  label: string;
  value: number;
  onCommit: (n: number) => void;
  min?: number;
  unit?: string;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  // Text exists only while the user is typing; otherwise the committed value is shown.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? String(value);
  const invalid = !/^-?\d+$/.test(text) || Number(text) < min;
  return (
    <div className={className}>
      <Label htmlFor={id} className="mb-1 text-xs text-muted-foreground">
        {label} {unit && <span className="opacity-70">({unit})</span>}
      </Label>
      <Input
        id={id}
        inputMode="numeric"
        value={text}
        disabled={disabled}
        aria-invalid={invalid}
        className="h-8"
        onChange={(e) => {
          setDraft(e.target.value);
          if (/^-?\d+$/.test(e.target.value) && Number(e.target.value) >= min) onCommit(Number(e.target.value));
        }}
        onBlur={() => setDraft(null)}
      />
    </div>
  );
}

export function TextField({
  label,
  value,
  onCommit,
  disabled,
  className,
  placeholder,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className={className}>
      <Label htmlFor={id} className="mb-1 text-xs text-muted-foreground">
        {label}
      </Label>
      <Input id={id} value={value} disabled={disabled} placeholder={placeholder} className="h-8" onChange={(e) => onCommit(e.target.value)} />
    </div>
  );
}

export const selectClass =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";
