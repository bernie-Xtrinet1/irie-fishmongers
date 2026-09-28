-- Sticky deny-only authority. No prior migration or W2 lifecycle is changed.
CREATE TYPE "ProductReservationRestrictionState" AS ENUM ('PREPARED', 'ENFORCED');
CREATE TYPE "ProductReservationRestrictionReason" AS ENUM ('ACCOUNTING_DRIFT', 'MALFORMED_RESOURCE', 'INCOMPLETE_EVIDENCE');
CREATE TABLE reservation_product_restrictions (
 id uuid PRIMARY KEY,
 "productId" text NOT NULL UNIQUE REFERENCES products(id) ON DELETE RESTRICT,
 "restrictionRevision" integer NOT NULL DEFAULT 1 CHECK ("restrictionRevision" = 1),
 "reasonCategory" "ProductReservationRestrictionReason" NOT NULL,
 "observationDigest" text NOT NULL CHECK ("observationDigest" ~ '^[0-9a-f]{64}$'),
 state "ProductReservationRestrictionState" NOT NULL DEFAULT 'PREPARED',
 "preparedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "firstEnforcedAt" timestamp(3),
 "physicalProtocolVersion" integer NOT NULL DEFAULT 1 CHECK ("physicalProtocolVersion" = 1),
 CHECK ((state = 'PREPARED' AND "firstEnforcedAt" IS NULL) OR (state = 'ENFORCED' AND "firstEnforcedAt" IS NOT NULL))
);
CREATE TABLE reservation_product_restriction_installations (
 "restrictionId" uuid NOT NULL REFERENCES reservation_product_restrictions(id) ON DELETE RESTRICT,
 incarnation uuid NOT NULL,
 epoch integer NOT NULL CHECK (epoch > 0),
 "protocolVersion" integer NOT NULL CHECK ("protocolVersion" = 1),
 acknowledgement text NOT NULL,
 "acknowledgementHash" text NOT NULL CHECK ("acknowledgementHash" ~ '^[0-9a-f]{64}$'),
 "confirmedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("restrictionId", incarnation, epoch, "protocolVersion")
);

CREATE FUNCTION product_restriction_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(1380339280, 1);
 IF TG_OP IN ('DELETE', 'TRUNCATE') THEN RAISE EXCEPTION 'permanent product restriction'; END IF;
 IF TG_OP = 'INSERT' THEN
  IF NEW.state <> 'PREPARED' OR NEW."firstEnforcedAt" IS NOT NULL THEN RAISE EXCEPTION 'restriction must start prepared'; END IF;
  NEW."preparedAt" := CURRENT_TIMESTAMP;
  RETURN NEW;
 END IF;
 IF (to_jsonb(NEW) - 'state' - 'firstEnforcedAt') IS DISTINCT FROM
    (to_jsonb(OLD) - 'state' - 'firstEnforcedAt') THEN RAISE EXCEPTION 'immutable restriction identity'; END IF;
 IF OLD.state = 'ENFORCED' THEN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'permanent enforcement'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.state = 'ENFORCED' THEN
  IF NOT EXISTS (SELECT 1 FROM reservation_product_restriction_installations WHERE "restrictionId"=NEW.id)
   THEN RAISE EXCEPTION 'installation acknowledgement required'; END IF;
  NEW."firstEnforcedAt" := CURRENT_TIMESTAMP;
 ELSIF NEW."firstEnforcedAt" IS NOT NULL THEN RAISE EXCEPTION 'premature enforcement'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER product_restriction_guard BEFORE INSERT OR UPDATE OR DELETE ON reservation_product_restrictions
FOR EACH ROW EXECUTE FUNCTION product_restriction_guard();
CREATE TRIGGER product_restriction_truncate BEFORE TRUNCATE ON reservation_product_restrictions
FOR EACH STATEMENT EXECUTE FUNCTION product_restriction_guard();

CREATE FUNCTION product_restriction_installation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE r reservation_product_restrictions; expected text;
BEGIN
 PERFORM pg_advisory_xact_lock(1380339280, 1);
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'append-only restriction evidence'; END IF;
 SELECT * INTO STRICT r FROM reservation_product_restrictions WHERE id=NEW."restrictionId";
 expected := '{"version":1,"productId":' || to_json(r."productId")::text || ',"state":"RESTRICTED","restrictionId":' ||
   to_json(r.id::text)::text || ',"restrictionRevision":1,"incarnation":' || to_json(NEW.incarnation::text)::text ||
   ',"epoch":' || NEW.epoch::text || '}';
 IF NEW.acknowledgement IS DISTINCT FROM expected OR
    NEW."acknowledgementHash" <> encode(sha256(convert_to(NEW.acknowledgement,'UTF8')),'hex')
 THEN RAISE EXCEPTION 'exact installation evidence required'; END IF;
 NEW."confirmedAt" := CURRENT_TIMESTAMP;
 RETURN NEW;
END $$;
CREATE TRIGGER product_restriction_installation_guard BEFORE INSERT OR UPDATE OR DELETE ON reservation_product_restriction_installations
FOR EACH ROW EXECUTE FUNCTION product_restriction_installation_guard();
CREATE TRIGGER product_restriction_installation_truncate BEFORE TRUNCATE ON reservation_product_restriction_installations
FOR EACH STATEMENT EXECUTE FUNCTION product_restriction_installation_guard();

CREATE FUNCTION product_restriction_w1_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
BEGIN
 IF NEW.effect = 'W1' THEN
  PERFORM pg_advisory_xact_lock(1380339280, 1);
  IF EXISTS (SELECT 1 FROM reservation_product_restrictions r
    JOIN cart_reservation_sync_states m ON m."productId"=r."productId" WHERE m.id=NEW."markerId")
   THEN RAISE EXCEPTION 'product restriction denies new W1'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER product_restriction_w1_guard BEFORE INSERT ON ordinary_reservation_commands
FOR EACH ROW EXECUTE FUNCTION product_restriction_w1_guard();

-- Resolve protocol tables before pg_temp; retain disposable-schema portability.
DO $$
DECLARE fn text;
BEGIN
 FOREACH fn IN ARRAY ARRAY['product_restriction_guard','product_restriction_installation_guard','product_restriction_w1_guard'] LOOP
  EXECUTE format('ALTER FUNCTION %I.%I() SET search_path = pg_catalog, %I, pg_temp', current_schema(), fn, current_schema());
 END LOOP;
END $$;
