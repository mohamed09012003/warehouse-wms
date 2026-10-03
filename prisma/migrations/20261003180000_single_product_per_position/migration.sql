-- Business rule: a Position holds stock of ONE product at a time.
--
-- Enforced by the database: at most one InventoryBalance row per position may have onHand > 0.
-- Rows with onHand = 0 are ignored, so an emptied position is immediately open to any product and
-- no permanent product assignment is kept. reserved <= onHand (existing CHECK) means a position
-- with reserved stock always has onHand > 0, so reservations keep their product on the position.
--
-- A partial unique index is atomic under concurrency: two requests that try to put different
-- products on the same empty position cannot both commit; the loser gets a unique violation
-- (23505) that the application reports as POSITION_OCCUPIED.
--
-- Prisma cannot model partial indexes, so schema.prisma is unchanged (see docs/database.md).

-- Refuse to proceed (with a readable message) if existing data already breaks the rule.
-- Nothing is modified or deleted: move one product to another position, then re-run the migration.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(code || ' (' || products || ' products)', ', ' ORDER BY code)
    INTO offenders
    FROM (
      SELECT p."code", count(*) AS products
        FROM "InventoryBalance" b
        JOIN "Position" p ON p."id" = b."positionId"
       WHERE b."onHand" > 0
       GROUP BY p."id", p."code"
      HAVING count(*) > 1
    ) AS x;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot enforce one product per position: these positions already hold more than one product: %', offenders
      USING HINT = 'Move the stock of all but one product to other positions (Inventory > Move), then apply this migration again.';
  END IF;
END
$$;

CREATE UNIQUE INDEX "InventoryBalance_one_product_per_position_idx"
  ON "InventoryBalance" ("positionId")
  WHERE "onHand" > 0;
