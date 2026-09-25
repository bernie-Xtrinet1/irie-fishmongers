-- CreateEnum
CREATE TYPE "OrdinaryInvalidationStatus" AS ENUM ('PREPARED', 'BARRIER_CONFIRMED', 'PUBLISHED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "ordinary_invalidation_intents" (
    "id" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "kind" VARCHAR(8) NOT NULL,
    "request" JSONB NOT NULL,
    "digest" CHAR(64) NOT NULL,
    "status" "OrdinaryInvalidationStatus" NOT NULL DEFAULT 'PREPARED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgement" TEXT,
    "acknowledgementHash" CHAR(64),
    "publicationTx" BIGINT,
    "publishedAt" TIMESTAMPTZ(3),
    "resultReference" JSONB,
    "supersededById" UUID,

    CONSTRAINT "ordinary_invalidation_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ordinary_invalidation_heads" (
    "scope" TEXT NOT NULL,
    "incarnation" UUID NOT NULL,
    "epoch" INTEGER NOT NULL,
    "publishedRevision" INTEGER NOT NULL DEFAULT 0,
    "allocatedRevision" INTEGER NOT NULL DEFAULT 0,
    "ready" BOOLEAN NOT NULL DEFAULT false,
    "pendingIntentId" UUID,

    CONSTRAINT "ordinary_invalidation_heads_pkey" PRIMARY KEY ("scope")
);

-- CreateTable
CREATE TABLE "ordinary_invalidation_scopes" (
    "intentId" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "previousRevision" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,

    CONSTRAINT "ordinary_invalidation_scopes_pkey" PRIMARY KEY ("intentId","scope")
);

-- CreateTable
CREATE TABLE "ordinary_command_barrier_bindings" (
    "commandId" UUID NOT NULL,
    "replayId" UUID NOT NULL,
    "markerId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "globalRevision" INTEGER NOT NULL,
    "markerRevision" INTEGER NOT NULL,
    "incarnation" UUID NOT NULL,
    "epoch" INTEGER NOT NULL,

    CONSTRAINT "ordinary_command_barrier_bindings_pkey" PRIMARY KEY ("commandId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ordinary_invalidation_intents_operationId_key" ON "ordinary_invalidation_intents"("operationId");

-- CreateIndex
CREATE INDEX "ordinary_invalidation_intents_status_id_idx" ON "ordinary_invalidation_intents"("status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ordinary_invalidation_scopes_scope_revision_key" ON "ordinary_invalidation_scopes"("scope", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "ordinary_command_barrier_bindings_replayId_key" ON "ordinary_command_barrier_bindings"("replayId");

-- AddForeignKey
ALTER TABLE "ordinary_invalidation_intents" ADD CONSTRAINT "ordinary_invalidation_intents_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "ordinary_invalidation_intents"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ordinary_invalidation_heads" ADD CONSTRAINT "ordinary_invalidation_heads_pendingIntentId_fkey" FOREIGN KEY ("pendingIntentId") REFERENCES "ordinary_invalidation_intents"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ordinary_invalidation_scopes" ADD CONSTRAINT "ordinary_invalidation_scopes_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "ordinary_invalidation_intents"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ordinary_invalidation_scopes" ADD CONSTRAINT "ordinary_invalidation_scopes_scope_fkey" FOREIGN KEY ("scope") REFERENCES "ordinary_invalidation_heads"("scope") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ordinary_command_barrier_bindings" ADD CONSTRAINT "ordinary_command_barrier_bindings_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "ordinary_reservation_commands"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- No enrollment or authority backfill. All guards are inert without heads.
CREATE FUNCTION ordinary_invalidation_canonical(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result text;
BEGIN
 IF jsonb_typeof(value)='object' THEN
  SELECT '{'||COALESCE(string_agg(to_jsonb(key)::text||':'||ordinary_invalidation_canonical(v),',' ORDER BY key COLLATE "C"),'')||'}'
   INTO result FROM jsonb_each(value) AS item(key,v);
 ELSIF jsonb_typeof(value)='array' THEN
  SELECT '['||COALESCE(string_agg(ordinary_invalidation_canonical(v),',' ORDER BY position),'')||']'
   INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS item(v,position);
 ELSE result=value::text; END IF;
 RETURN result;
END $$;
ALTER TABLE ordinary_invalidation_heads ADD CONSTRAINT invalidation_head_bounds CHECK
 (epoch > 0 AND "publishedRevision" >= 0 AND "allocatedRevision" >= "publishedRevision"
  AND (scope='GLOBAL' OR scope ~ '^MARKER:[0-9a-f-]{36}$'));
ALTER TABLE ordinary_invalidation_scopes ADD CONSTRAINT invalidation_scope_bounds CHECK
 ("previousRevision" >= 0 AND revision::bigint = "previousRevision"::bigint+1);
ALTER TABLE ordinary_command_barrier_bindings ADD CONSTRAINT invalidation_binding_bounds CHECK
 (version=1 AND epoch>0 AND "globalRevision">=0 AND "markerRevision">=0);
ALTER TABLE ordinary_invalidation_intents ADD CONSTRAINT invalidation_intent_shape CHECK
 ((kind IN ('CART','OWNER','FENCE','MODE') AND digest ~ '^[0-9a-f]{64}$'
  AND digest=encode(sha256(convert_to(ordinary_invalidation_canonical(request),'UTF8')),'hex')
  AND request->>'intentId'=id::text AND request->>'operationId'="operationId"::text
  AND request->>'kind'=kind AND (request->>'version')::integer=1
  AND request ?& ARRAY['version','intentId','operationId','kind','incarnation','epoch','scopes']
  AND request-ARRAY['version','intentId','operationId','kind','incarnation','epoch','scopes']='{}'::jsonb
  AND request->>'incarnation' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND (request->>'epoch')::integer>0
  AND jsonb_typeof(request->'scopes')='array' AND jsonb_array_length(request->'scopes') BETWEEN 1 AND 100) IS TRUE);

CREATE FUNCTION ordinary_invalidation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'invalidation identity/evidence cannot be updated or deleted';
END $$;
CREATE TRIGGER invalidation_scope_immutable BEFORE UPDATE OR DELETE ON ordinary_invalidation_scopes
 FOR EACH ROW EXECUTE FUNCTION ordinary_invalidation_immutable();
CREATE TRIGGER invalidation_binding_immutable BEFORE UPDATE OR DELETE ON ordinary_command_barrier_bindings
 FOR EACH ROW EXECUTE FUNCTION ordinary_invalidation_immutable();

CREATE FUNCTION ordinary_invalidation_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_ack jsonb; s jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'invalidation obligation cannot be deleted'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'PREPARED' OR NEW.acknowledgement IS NOT NULL OR NEW."acknowledgementHash" IS NOT NULL
   OR NEW."publicationTx" IS NOT NULL OR NEW."publishedAt" IS NOT NULL OR NEW."resultReference" IS NOT NULL
   OR NEW."supersededById" IS NOT NULL THEN RAISE EXCEPTION 'invalidation must start PREPARED'; END IF;
  RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['status','acknowledgement','acknowledgementHash','publicationTx','publishedAt','resultReference','supersededById'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','acknowledgement','acknowledgementHash','publicationTx','publishedAt','resultReference','supersededById'])
  THEN RAISE EXCEPTION 'invalidation request identity immutable'; END IF;
 IF OLD.status IN ('PUBLISHED','SUPERSEDED') THEN RAISE EXCEPTION 'terminal invalidation immutable'; END IF;
 IF OLD.acknowledgement IS NOT NULL AND ROW(NEW.acknowledgement,NEW."acknowledgementHash")
   IS DISTINCT FROM ROW(OLD.acknowledgement,OLD."acknowledgementHash") THEN RAISE EXCEPTION 'barrier evidence immutable'; END IF;
 IF NEW.status='BARRIER_CONFIRMED' THEN
  IF OLD.status NOT IN ('PREPARED','BARRIER_CONFIRMED') THEN RAISE EXCEPTION 'invalid confirmation'; END IF;
  SELECT jsonb_build_object('version',1,'intentId',NEW.id::text,'digest',NEW.digest,
    'incarnation',NEW.request->>'incarnation','epoch',(NEW.request->>'epoch')::integer,
    'scopes',jsonb_agg(jsonb_build_object('scope',s.scope,'previousRevision',s."previousRevision",'revision',s.revision) ORDER BY s.scope))
    INTO expected_ack FROM ordinary_invalidation_scopes s WHERE s."intentId"=NEW.id;
  IF NEW.acknowledgement IS NULL OR NEW.acknowledgement::jsonb IS DISTINCT FROM expected_ack
    OR NEW."acknowledgementHash" IS DISTINCT FROM encode(sha256(convert_to(NEW.acknowledgement,'UTF8')),'hex')
    THEN RAISE EXCEPTION 'exact complete barrier acknowledgement required'; END IF;
 ELSIF NEW.status='PUBLISHED' THEN
  IF OLD.status<>'BARRIER_CONFIRMED' OR NEW."publicationTx" IS DISTINCT FROM txid_current()
    OR NEW."publishedAt" IS NULL OR NEW."resultReference" IS NULL
    THEN RAISE EXCEPTION 'publication requires confirmed transaction'; END IF;
 ELSIF NEW.status='SUPERSEDED' THEN
  IF OLD.status<>'BARRIER_CONFIRMED' OR NEW."supersededById" IS NULL OR NEW."supersededById"=NEW.id OR NOT EXISTS (
    SELECT 1 FROM ordinary_invalidation_intents replacement WHERE replacement.id=NEW."supersededById" AND replacement.status='PREPARED')
    THEN RAISE EXCEPTION 'explicit replacement required'; END IF;
 ELSE RAISE EXCEPTION 'invalidation cannot revert to PREPARED'; END IF;
 IF NEW."publicationTx" IS DISTINCT FROM OLD."publicationTx" AND NOT
   (OLD."publicationTx" IS NULL AND NEW."publicationTx"=txid_current() AND NEW.status='BARRIER_CONFIRMED')
   THEN RAISE EXCEPTION 'publication transaction immutable'; END IF;
 IF OLD."publicationTx" IS NULL AND NEW."publicationTx" IS NOT NULL THEN
  FOR s IN SELECT snapshot FROM ordinary_invalidation_scopes WHERE "intentId"=NEW.id LOOP
   -- Reuse the exact state projection for the preimage, including unchanged
   -- resources. Domain-write triggers additionally bind each physical SQL write.
   IF NOT ordinary_invalidation_after_matches(s || jsonb_build_object(
     'after',s->'before','cartAfter',s->'cartBefore','ownersAfter',s->'ownersBefore','modeAfter',NULL))
     THEN RAISE EXCEPTION 'publication preimage mismatch'; END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invalidation_intent_guard BEFORE INSERT OR UPDATE OR DELETE ON ordinary_invalidation_intents
 FOR EACH ROW EXECUTE FUNCTION ordinary_invalidation_intent_guard();

CREATE FUNCTION ordinary_invalidation_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'invalidation head cannot be removed'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW."publishedRevision"<>0 OR NEW."allocatedRevision"<>0 OR NEW.ready OR NEW."pendingIntentId" IS NOT NULL
    THEN RAISE EXCEPTION 'enrollment starts closed at zero'; END IF;
  IF NEW.scope<>'GLOBAL' AND NOT EXISTS (SELECT 1 FROM cart_reservation_sync_states m
    WHERE 'MARKER:'||m.id=NEW.scope AND m."ordinaryProvenanceState"='NEW'
     AND NOT EXISTS (SELECT 1 FROM ordinary_reservation_commands c WHERE c."markerId"=m.id))
    THEN RAISE EXCEPTION 'historical scope cannot be enrolled'; END IF;
 ELSE
  IF ROW(NEW.scope,NEW.incarnation,NEW.epoch) IS DISTINCT FROM ROW(OLD.scope,OLD.incarnation,OLD.epoch)
    OR NEW."publishedRevision"<OLD."publishedRevision" OR NEW."allocatedRevision"<OLD."allocatedRevision"
    OR NEW."allocatedRevision"::bigint>OLD."allocatedRevision"::bigint+1
    THEN RAISE EXCEPTION 'invalidation head regression/rebinding'; END IF;
  IF NEW."allocatedRevision">OLD."allocatedRevision" AND (NEW."pendingIntentId" IS NULL OR NEW.ready)
    THEN RAISE EXCEPTION 'allocation requires closed pending intent'; END IF;
  IF NEW.ready AND (NEW."pendingIntentId" IS NOT NULL OR NEW."publishedRevision"<>NEW."allocatedRevision")
    THEN RAISE EXCEPTION 'pending scope cannot be ready'; END IF;
  IF NEW."publishedRevision">OLD."publishedRevision" AND NOT EXISTS (
    SELECT 1 FROM ordinary_invalidation_intents i JOIN ordinary_invalidation_scopes s ON s."intentId"=i.id
    WHERE i.id=OLD."pendingIntentId" AND i.status='PUBLISHED' AND i."publicationTx"=txid_current()
      AND s.scope=NEW.scope AND s.revision=NEW."publishedRevision")
    THEN RAISE EXCEPTION 'head publication requires atomic domain publication'; END IF;
  IF OLD."pendingIntentId" IS NOT NULL AND NEW."pendingIntentId" IS DISTINCT FROM OLD."pendingIntentId" THEN
   IF NEW."pendingIntentId" IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM ordinary_invalidation_intents WHERE id=OLD."pendingIntentId" AND status='PUBLISHED')
      THEN RAISE EXCEPTION 'pending obligation cannot be cleared'; END IF;
   ELSIF NOT EXISTS (SELECT 1 FROM ordinary_invalidation_intents WHERE id=OLD."pendingIntentId" AND status='SUPERSEDED'
      AND "supersededById"=NEW."pendingIntentId") THEN RAISE EXCEPTION 'explicit supersession required'; END IF;
  END IF;
  IF NEW.ready AND NOT EXISTS (SELECT 1 FROM ordinary_invalidation_scopes s JOIN ordinary_invalidation_intents i ON i.id=s."intentId"
    WHERE s.scope=NEW.scope AND s.revision=NEW."publishedRevision" AND i.status='PUBLISHED')
    THEN RAISE EXCEPTION 'readiness requires published scope evidence'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invalidation_head_guard BEFORE INSERT OR UPDATE OR DELETE ON ordinary_invalidation_heads
 FOR EACH ROW EXECUTE FUNCTION ordinary_invalidation_head_guard();

CREATE FUNCTION ordinary_invalidation_after_matches(s jsonb) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE m cart_reservation_sync_states%ROWTYPE; item cart_items%ROWTYPE;
 f reservation_fence_transitions%ROWTYPE; mode reservation_engine_mode_configs%ROWTYPE; owners jsonb; customer text;
BEGIN
 IF s->>'kind'='MARKER' THEN
  SELECT * INTO m FROM cart_reservation_sync_states WHERE id=s->>'markerId';
  SELECT "customerId" INTO customer FROM carts WHERE id=m."cartId";
  SELECT * INTO item FROM cart_items WHERE "cartId"=m."cartId" AND "productId"=m."productId";
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'state',state) ORDER BY id),'[]'::jsonb) INTO owners
    FROM ordinary_reservation_owners WHERE "markerId"=m.id;
  RETURN COALESCE(m."cartId"=s->>'cartId' AND m."productId"=s->>'productId' AND customer=s->>'customerId'
    AND jsonb_build_object('generation',m.generation,'mutationVersion',m."expectedMutationVersion",'quantity',m."expectedQuantity")=s->'after'
    AND (CASE WHEN item.id IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('id',item.id,'quantity',item.quantity,'mutationVersion',item."mutationVersion") END)=s->'cartAfter'
    AND owners=s->'ownersAfter',false);
 END IF;
 SELECT * INTO f FROM reservation_fence_transitions ORDER BY revision DESC LIMIT 1;
 SELECT * INTO mode FROM reservation_engine_mode_configs ORDER BY revision DESC LIMIT 1;
 RETURN COALESCE(jsonb_build_object('incarnation',f.incarnation,'epoch',f.epoch,'revision',f.revision,'phase',f.phase,'protocol',f.protocol,'transitionId',f.id)=s->'after'
   AND (CASE WHEN s->'modeAfter'='null'::jsonb THEN COALESCE(mode.mode::text,'LEGACY')=s->'modeBefore'->>'mode'
      AND mode.revision IS NOT DISTINCT FROM (s->'modeBefore'->>'revision')::integer
    ELSE mode.mode::text=s->>'modeAfter' AND mode.revision>COALESCE((s->'modeBefore'->>'revision')::integer,0) END),false);
END $$;

CREATE FUNCTION ordinary_invalidation_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i ordinary_invalidation_intents%ROWTYPE; h ordinary_invalidation_heads%ROWTYPE; key uuid;
BEGIN
 IF TG_TABLE_NAME='ordinary_invalidation_intents' THEN key=NEW.id;
 ELSIF TG_TABLE_NAME='ordinary_invalidation_scopes' THEN key=NEW."intentId";
 ELSE
  SELECT * INTO h FROM ordinary_invalidation_heads WHERE scope=NEW.scope;
  key=h."pendingIntentId";
  IF key IS NULL THEN
   IF h."allocatedRevision"<>h."publishedRevision" THEN RAISE EXCEPTION 'lost pending obligation'; END IF;
   RETURN NULL;
  END IF;
 END IF;
 SELECT * INTO i FROM ordinary_invalidation_intents WHERE id=key;
 IF i."publicationTx" IS NOT NULL AND i.status<>'PUBLISHED' THEN RAISE EXCEPTION 'publication must finish atomically'; END IF;
 IF i.status='PUBLISHED' AND EXISTS (SELECT 1 FROM ordinary_invalidation_scopes s WHERE s."intentId"=i.id AND NOT ordinary_invalidation_after_matches(s.snapshot))
   THEN RAISE EXCEPTION 'publication requires exact intended domain state'; END IF;
 IF (SELECT count(*) FROM ordinary_invalidation_scopes WHERE "intentId"=i.id)<>jsonb_array_length(i.request->'scopes')
   THEN RAISE EXCEPTION 'incomplete invalidation scopes'; END IF;
 IF EXISTS (SELECT 1 FROM ordinary_invalidation_scopes s WHERE s."intentId"=i.id AND (
    NOT (i.request->'scopes' @> jsonb_build_array(s.snapshot))
    OR s.scope IS DISTINCT FROM CASE WHEN s.snapshot->>'kind'='GLOBAL' THEN 'GLOBAL' ELSE 'MARKER:'||(s.snapshot->>'markerId') END
    OR s."previousRevision" IS DISTINCT FROM (s.snapshot->>'revision')::integer))
    THEN RAISE EXCEPTION 'invalidation scope/request identity mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM ordinary_invalidation_scopes s JOIN ordinary_invalidation_heads head ON head.scope=s.scope
   WHERE s."intentId"=i.id AND (
    head.incarnation::text IS DISTINCT FROM i.request->>'incarnation' OR head.epoch IS DISTINCT FROM (i.request->>'epoch')::integer
    OR (i.status IN ('PREPARED','BARRIER_CONFIRMED') AND (head."pendingIntentId" IS DISTINCT FROM i.id OR head."allocatedRevision"<>s.revision OR head.ready))
    OR (i.status='PUBLISHED' AND head."publishedRevision"<s.revision)
    OR (i.status='SUPERSEDED' AND NOT EXISTS (SELECT 1 FROM ordinary_invalidation_scopes replacement
      WHERE replacement."intentId"=i."supersededById" AND replacement.scope=s.scope AND replacement.revision>s.revision))))
   THEN RAISE EXCEPTION 'invalidation scope obligation mismatch'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER invalidation_intent_consistency AFTER INSERT OR UPDATE ON ordinary_invalidation_intents
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ordinary_invalidation_consistency();
CREATE CONSTRAINT TRIGGER invalidation_scope_consistency AFTER INSERT ON ordinary_invalidation_scopes
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ordinary_invalidation_consistency();
CREATE CONSTRAINT TRIGGER invalidation_head_consistency AFTER INSERT OR UPDATE ON ordinary_invalidation_heads
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ordinary_invalidation_consistency();

CREATE FUNCTION ordinary_invalidation_bind_command() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g ordinary_invalidation_heads%ROWTYPE; m ordinary_invalidation_heads%ROWTYPE; o ordinary_reservation_owners%ROWTYPE;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM ordinary_invalidation_heads WHERE scope='MARKER:'||NEW."markerId") THEN RETURN NEW; END IF;
 SELECT * INTO o FROM ordinary_reservation_owners WHERE id=NEW."ownerId";
 PERFORM scope FROM ordinary_invalidation_heads WHERE scope IN ('GLOBAL','MARKER:'||NEW."markerId") ORDER BY scope FOR UPDATE;
 SELECT * INTO g FROM ordinary_invalidation_heads WHERE scope='GLOBAL';
 SELECT * INTO m FROM ordinary_invalidation_heads WHERE scope='MARKER:'||NEW."markerId";
 IF NOT COALESCE(g.ready AND m.ready AND g."pendingIntentId" IS NULL AND m."pendingIntentId" IS NULL
   AND g.incarnation=o.incarnation AND m.incarnation=o.incarnation
   AND g.epoch=o."reservationExecutionEpoch" AND m.epoch=o."reservationExecutionEpoch",false)
   THEN RAISE EXCEPTION 'invalidation blocks command issuance'; END IF;
 INSERT INTO ordinary_command_barrier_bindings
  ("commandId","replayId","markerId",version,"globalRevision","markerRevision",incarnation,epoch)
 VALUES (NEW.id,NEW."replayId",NEW."markerId",1,g."publishedRevision",m."publishedRevision",o.incarnation,o."reservationExecutionEpoch");
 RETURN NEW;
END $$;
CREATE TRIGGER invalidation_command_binding AFTER INSERT ON ordinary_reservation_commands
 FOR EACH ROW EXECUTE FUNCTION ordinary_invalidation_bind_command();

CREATE FUNCTION ordinary_invalidation_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c ordinary_reservation_commands%ROWTYPE; o ordinary_reservation_owners%ROWTYPE;
BEGIN
 SELECT * INTO c FROM ordinary_reservation_commands WHERE id=NEW."commandId" AND xmin=txid_current()::text::xid;
 SELECT * INTO o FROM ordinary_reservation_owners WHERE id=c."ownerId";
 IF c.id IS NULL OR ROW(NEW."replayId",NEW."markerId",NEW.incarnation,NEW.epoch)
   IS DISTINCT FROM ROW(c."replayId",c."markerId",o.incarnation,o."reservationExecutionEpoch")
   OR NOT EXISTS (SELECT 1 FROM ordinary_invalidation_heads WHERE scope='GLOBAL' AND ready
     AND "pendingIntentId" IS NULL AND "publishedRevision"=NEW."globalRevision" AND incarnation=NEW.incarnation AND epoch=NEW.epoch)
   OR NOT EXISTS (SELECT 1 FROM ordinary_invalidation_heads WHERE scope='MARKER:'||NEW."markerId" AND ready
     AND "pendingIntentId" IS NULL AND "publishedRevision"=NEW."markerRevision" AND incarnation=NEW.incarnation AND epoch=NEW.epoch)
   THEN RAISE EXCEPTION 'binding requires exact command creation transaction'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invalidation_binding_guard BEFORE INSERT ON ordinary_command_barrier_bindings
 FOR EACH ROW EXECUTE FUNCTION ordinary_invalidation_binding_guard();

CREATE FUNCTION ordinary_invalidation_publication_scope(scope_key text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE snapshot jsonb;
BEGIN
 SELECT s.snapshot INTO snapshot FROM ordinary_invalidation_scopes s
  JOIN ordinary_invalidation_intents i ON i.id=s."intentId"
  JOIN ordinary_invalidation_heads h ON h.scope=s.scope
  WHERE s.scope=scope_key AND i.status='BARRIER_CONFIRMED' AND i."publicationTx"=txid_current()
    AND h."pendingIntentId"=i.id AND h."allocatedRevision"=s.revision;
 IF snapshot IS NULL THEN RAISE EXCEPTION 'enrolled publication requires exact confirmed intent'; END IF;
 RETURN snapshot;
END $$;

CREATE FUNCTION ordinary_invalidation_domain_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text; s jsonb; before_state jsonb; after_state jsonb; old_row jsonb; new_row jsonb;
BEGIN
 old_row=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
 new_row=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
 IF TG_TABLE_NAME='cart_items' THEN
  IF TG_OP='UPDATE' AND ROW(NEW.id,NEW."cartId",NEW."productId") IS DISTINCT FROM ROW(OLD.id,OLD."cartId",OLD."productId")
    AND EXISTS (SELECT 1 FROM cart_reservation_sync_states m JOIN ordinary_invalidation_heads h ON h.scope='MARKER:'||m.id
      WHERE (m."cartId"=OLD."cartId" AND m."productId"=OLD."productId")
         OR (m."cartId"=NEW."cartId" AND m."productId"=NEW."productId"))
    THEN RAISE EXCEPTION 'enrolled cart identity immutable'; END IF;
  SELECT 'MARKER:'||id INTO k FROM cart_reservation_sync_states
   WHERE "cartId"=COALESCE(new_row,old_row)->>'cartId' AND "productId"=COALESCE(new_row,old_row)->>'productId';
  IF k IS NULL OR NOT EXISTS (SELECT 1 FROM ordinary_invalidation_heads WHERE scope=k) THEN RETURN COALESCE(NEW,OLD); END IF;
  before_state=CASE WHEN old_row IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('id',old_row->'id','quantity',old_row->'quantity','mutationVersion',old_row->'mutationVersion') END;
  after_state=CASE WHEN new_row IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('id',new_row->'id','quantity',new_row->'quantity','mutationVersion',new_row->'mutationVersion') END;
  IF before_state=after_state THEN RETURN COALESCE(NEW,OLD); END IF;
  s=ordinary_invalidation_publication_scope(k);
  IF before_state IS DISTINCT FROM s->'cartBefore' OR after_state IS DISTINCT FROM s->'cartAfter'
    THEN RAISE EXCEPTION 'cart publication mismatch'; END IF;
 ELSIF TG_TABLE_NAME='cart_reservation_sync_states' THEN
  IF TG_OP='UPDATE' AND ROW(NEW.id,NEW."cartId",NEW."productId") IS DISTINCT FROM ROW(OLD.id,OLD."cartId",OLD."productId")
    AND EXISTS (SELECT 1 FROM ordinary_invalidation_heads WHERE scope IN ('MARKER:'||OLD.id,'MARKER:'||NEW.id))
    THEN RAISE EXCEPTION 'enrolled marker identity immutable'; END IF;
  k='MARKER:'||(COALESCE(new_row,old_row)->>'id');
  IF NOT EXISTS (SELECT 1 FROM ordinary_invalidation_heads WHERE scope=k) THEN RETURN COALESCE(NEW,OLD); END IF;
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'enrolled marker identity retained'; END IF;
  IF ROW(NEW.id,NEW."cartId",NEW."productId") IS DISTINCT FROM ROW(OLD.id,OLD."cartId",OLD."productId") THEN RAISE EXCEPTION 'enrolled marker identity immutable'; END IF;
  before_state=jsonb_build_object('generation',OLD.generation,'mutationVersion',OLD."expectedMutationVersion",'quantity',OLD."expectedQuantity");
  after_state=jsonb_build_object('generation',NEW.generation,'mutationVersion',NEW."expectedMutationVersion",'quantity',NEW."expectedQuantity");
  IF before_state=after_state THEN RETURN NEW; END IF;
  s=ordinary_invalidation_publication_scope(k);
  IF before_state IS DISTINCT FROM s->'before' OR after_state IS DISTINCT FROM s->'after' THEN RAISE EXCEPTION 'marker publication mismatch'; END IF;
 ELSIF TG_TABLE_NAME='ordinary_reservation_owners' THEN
  k='MARKER:'||NEW."markerId";
  IF NOT EXISTS (SELECT 1 FROM ordinary_invalidation_heads WHERE scope=k) OR NEW.state=OLD.state THEN RETURN NEW; END IF;
  -- These are historical acknowledgement effects; existing deferred lifecycle
  -- and journal guards still require their exact accepted command evidence.
  IF (OLD.state='ISSUED' AND NEW.state='ACTIVE') OR NEW.state IN ('SUPERSEDED','CONSUMED') THEN RETURN NEW; END IF;
  s=ordinary_invalidation_publication_scope(k);
  IF NOT (s->'ownersBefore' @> jsonb_build_array(jsonb_build_object('id',OLD.id,'state',OLD.state))
    AND s->'ownersAfter' @> jsonb_build_array(jsonb_build_object('id',NEW.id,'state',NEW.state)))
    THEN RAISE EXCEPTION 'owner publication mismatch'; END IF;
 ELSIF TG_TABLE_NAME='reservation_engine_mode_configs' THEN
   IF NOT EXISTS (SELECT 1 FROM ordinary_invalidation_heads WHERE scope='GLOBAL') THEN RETURN COALESCE(NEW,OLD); END IF;
   IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'enrolled mode history append-only'; END IF;
  s=ordinary_invalidation_publication_scope('GLOBAL');
  IF NEW.mode::text IS DISTINCT FROM s->>'modeAfter' OR NEW.mode<>'DRAINING' THEN RAISE EXCEPTION 'mode publication mismatch'; END IF;
 ELSE
  IF NOT EXISTS (SELECT 1 FROM ordinary_invalidation_heads WHERE scope='GLOBAL') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['status','acknowledgedAt'])=(to_jsonb(OLD)-ARRAY['status','acknowledgedAt']) THEN RETURN NEW; END IF;
  s=ordinary_invalidation_publication_scope('GLOBAL');
  after_state=jsonb_build_object('incarnation',NEW.incarnation,'epoch',NEW.epoch,'revision',NEW.revision,
    'phase',NEW.phase,'protocol',NEW.protocol,'transitionId',NEW.id);
  IF after_state IS DISTINCT FROM s->'after' OR NEW.phase NOT IN ('DRAINING','FROZEN') THEN RAISE EXCEPTION 'fence publication mismatch'; END IF;
 END IF;
 RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER invalidation_cart_publication BEFORE INSERT OR UPDATE OR DELETE ON cart_items
 FOR EACH ROW EXECUTE FUNCTION ordinary_invalidation_domain_guard();
CREATE TRIGGER invalidation_marker_publication BEFORE UPDATE OR DELETE ON cart_reservation_sync_states
 FOR EACH ROW EXECUTE FUNCTION ordinary_invalidation_domain_guard();
CREATE TRIGGER invalidation_owner_publication BEFORE UPDATE ON ordinary_reservation_owners
 FOR EACH ROW EXECUTE FUNCTION ordinary_invalidation_domain_guard();
CREATE TRIGGER invalidation_mode_publication BEFORE INSERT OR UPDATE OR DELETE ON reservation_engine_mode_configs
 FOR EACH ROW EXECUTE FUNCTION ordinary_invalidation_domain_guard();
CREATE TRIGGER invalidation_fence_publication BEFORE INSERT OR UPDATE ON reservation_fence_transitions
 FOR EACH ROW EXECUTE FUNCTION ordinary_invalidation_domain_guard();

-- TRUNCATE does not run row triggers. Preserve unenrolled compatibility, but
-- never let it erase protected mode history or expose implicit LEGACY mode.
CREATE FUNCTION ordinary_invalidation_mode_truncate_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM ordinary_invalidation_heads WHERE scope='GLOBAL')
   THEN RAISE EXCEPTION 'enrolled mode history cannot be truncated'; END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER invalidation_mode_truncate BEFORE TRUNCATE ON reservation_engine_mode_configs
 FOR EACH STATEMENT EXECUTE FUNCTION ordinary_invalidation_mode_truncate_guard();

-- Bind only this migration's functions to its installation schema, including
-- disposable schemas. pg_temp must be explicit and last; otherwise PostgreSQL
-- searches it first for relations. Builtins resolve in pg_catalog first.
-- These remain SECURITY INVOKER: no privilege elevation or caller-set flag.
DO $$
DECLARE installed_schema text := current_schema(); signature text;
BEGIN
 FOREACH signature IN ARRAY ARRAY[
  'ordinary_invalidation_canonical(jsonb)', 'ordinary_invalidation_immutable()',
  'ordinary_invalidation_intent_guard()', 'ordinary_invalidation_head_guard()',
  'ordinary_invalidation_after_matches(jsonb)', 'ordinary_invalidation_consistency()',
  'ordinary_invalidation_bind_command()', 'ordinary_invalidation_binding_guard()',
  'ordinary_invalidation_publication_scope(text)', 'ordinary_invalidation_domain_guard()',
  'ordinary_invalidation_mode_truncate_guard()'
 ] LOOP
  -- signature is a fixed migration literal; schema identifiers use %I quoting.
  EXECUTE format('ALTER FUNCTION %I.%s SET search_path TO pg_catalog, %I, pg_temp',
    installed_schema, signature, installed_schema);
 END LOOP;
END $$;
