-- Constraints Prisma cannot express (see docs/database.md).

-- Emails are stored lowercase so the unique index is effectively case-insensitive.
ALTER TABLE "User" ADD CONSTRAINT "User_email_lowercase_check" CHECK ("email" = lower("email"));

-- Slugs are URL path segments: lowercase letters/digits separated by single hyphens.
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_slug_format_check"
  CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") BETWEEN 2 AND 48);
