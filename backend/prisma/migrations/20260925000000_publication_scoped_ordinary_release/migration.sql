-- Inactive publication-scoped RELEASE. No enrollment, tables, or backfill.
-- UUIDv5 parity with ordinaryHoldInstanceId, without installing extensions.
CREATE FUNCTION ordinary_release_hold_identity(marker text, generation integer) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER AS $$
DECLARE message bytea; bit_length bigint; words bigint[]; state bigint[] := ARRAY[1732584193,4023233417,2562383102,271733878,3285377520]::bigint[];
 a bigint; b bigint; c bigint; d bigint; e bigint; v bigint; k bigint; temp bigint;
 block_offset integer; j integer; hex text; bytes bytea;
BEGIN
 IF length(marker)<>36 OR marker !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 OR generation<0
  THEN RAISE EXCEPTION 'invalid ordinary hold identity'; END IF;
 message=decode('6ba7b8109dad11d180b400c04fd430c8','hex')||convert_to('iriefishmongers:ordinary-reservation:v1:'||marker||':'||generation,'UTF8');
 bit_length=octet_length(message)::bigint*8;
 message=message||decode('80','hex');
 WHILE octet_length(message)%64<>56 LOOP message=message||decode('00','hex'); END LOOP;
 message=message||int8send(bit_length);
 FOR block_offset IN 0..(octet_length(message)/64-1) LOOP
  words=array_fill(0::bigint,ARRAY[80]);
  FOR j IN 0..15 LOOP
   words[j+1]=(get_byte(message,block_offset*64+j*4)::bigint<<24)
    |(get_byte(message,block_offset*64+j*4+1)::bigint<<16)
    |(get_byte(message,block_offset*64+j*4+2)::bigint<<8)|get_byte(message,block_offset*64+j*4+3)::bigint;
  END LOOP;
  FOR j IN 17..80 LOOP
   v=words[j-3]#words[j-8]#words[j-14]#words[j-16]; words[j]=((v<<1)|(v>>31))&4294967295;
  END LOOP;
  a=state[1]; b=state[2]; c=state[3]; d=state[4]; e=state[5];
  FOR j IN 1..80 LOOP
   IF j<=20 THEN v=(b&c)|((~b)&d); k=1518500249;
   ELSIF j<=40 THEN v=b#c#d; k=1859775393;
   ELSIF j<=60 THEN v=(b&c)|(b&d)|(c&d); k=2400959708;
   ELSE v=b#c#d; k=3395469782; END IF;
   temp=((((a<<5)|(a>>27))&4294967295)+v+e+k+words[j])&4294967295;
   e=d; d=c; c=((b<<30)|(b>>2))&4294967295; b=a; a=temp;
  END LOOP;
  state=ARRAY[(state[1]+a)&4294967295,(state[2]+b)&4294967295,(state[3]+c)&4294967295,(state[4]+d)&4294967295,(state[5]+e)&4294967295];
 END LOOP;
 hex=lpad(to_hex(state[1]),8,'0')||lpad(to_hex(state[2]),8,'0')||lpad(to_hex(state[3]),8,'0')||lpad(to_hex(state[4]),8,'0');
 bytes=decode(hex,'hex'); bytes=set_byte(bytes,6,(get_byte(bytes,6)&15)|80); bytes=set_byte(bytes,8,(get_byte(bytes,8)&63)|128);
 RETURN encode(bytes,'hex')::uuid;
END $$;

CREATE FUNCTION ordinary_release_binding(command_id uuid, creating boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE c ordinary_reservation_commands%ROWTYPE; o ordinary_reservation_owners%ROWTYPE;
 m cart_reservation_sync_states%ROWTYPE; s ordinary_invalidation_scopes%ROWTYPE;
 i ordinary_invalidation_intents%ROWTYPE; g ordinary_invalidation_heads%ROWTYPE;
 h ordinary_invalidation_heads%ROWTYPE; b ordinary_command_barrier_bindings%ROWTYPE;
BEGIN
 SELECT * INTO c FROM ordinary_reservation_commands WHERE id=command_id;
 SELECT * INTO o FROM ordinary_reservation_owners WHERE id=c."ownerId";
 SELECT * INTO m FROM cart_reservation_sync_states WHERE id=c."markerId";
 IF c.effect IS DISTINCT FROM 'RELEASE' OR m."ordinaryProvenanceState" IS DISTINCT FROM 'TRACKED'
  OR o."markerId" IS DISTINCT FROM m.id OR o."cartId" IS DISTINCT FROM m."cartId"
  OR o."productId" IS DISTINCT FROM m."productId" OR o."checkoutManifestId" IS NOT NULL
  OR o."holdInstanceId" IS DISTINCT FROM ordinary_release_hold_identity(o."markerId",o.generation)
  THEN RAISE EXCEPTION 'release provenance rejected'; END IF;
 IF creating THEN
  SELECT * INTO h FROM ordinary_invalidation_heads WHERE scope='MARKER:'||m.id FOR UPDATE;
  SELECT * INTO i FROM ordinary_invalidation_intents WHERE id=h."pendingIntentId";
  SELECT * INTO s FROM ordinary_invalidation_scopes WHERE "intentId"=i.id AND scope=h.scope;
  IF NOT COALESCE(i.status='BARRIER_CONFIRMED' AND i."publicationTx"=txid_current()
   AND h."allocatedRevision"=s.revision AND NOT h.ready AND o.state='ACTIVE'
   AND c.state='WAITING' AND c.sequence IS NULL AND c."expectedSequence" IS NULL
   AND c."attemptCount"=0 AND c."lastDispatchTransitionId" IS NULL
   AND c."completionReceiptHash" IS NULL AND c."acknowledgedAt" IS NULL
   AND EXISTS (SELECT 1 FROM ordinary_reservation_commands WHERE id=c.id AND xmin=txid_current()::text::xid),false)
   THEN RAISE EXCEPTION 'release requires active publication transaction'; END IF;
  SELECT * INTO g FROM ordinary_invalidation_heads WHERE scope='GLOBAL' FOR UPDATE;
  IF NOT COALESCE(g."pendingIntentId" IS NULL AND g."allocatedRevision"=g."publishedRevision"
   AND g.incarnation=o.incarnation AND g.epoch=o."reservationExecutionEpoch"
   AND EXISTS (SELECT 1 FROM ordinary_invalidation_scopes gs JOIN ordinary_invalidation_intents gi ON gi.id=gs."intentId"
    WHERE gs.scope='GLOBAL' AND gs.revision=g."publishedRevision" AND gi.status='PUBLISHED'),false)
   THEN RAISE EXCEPTION 'release global publication required'; END IF;
 ELSE
  SELECT * INTO b FROM ordinary_command_barrier_bindings WHERE "commandId"=c.id;
  SELECT * INTO s FROM ordinary_invalidation_scopes WHERE scope='MARKER:'||m.id AND revision=b."markerRevision";
  SELECT * INTO i FROM ordinary_invalidation_intents WHERE id=s."intentId";
  IF NOT COALESCE(i.status='PUBLISHED' AND b."replayId"=c."replayId" AND b."markerId"=m.id
   AND b.incarnation=o.incarnation AND b.epoch=o."reservationExecutionEpoch" AND b.version=1,false)
   THEN RAISE EXCEPTION 'release publication evidence required'; END IF;
 END IF;
 IF NOT COALESCE(i.kind IN ('CART','OWNER') AND i.request->>'incarnation'=o.incarnation::text
  AND (i.request->>'epoch')::integer=o."reservationExecutionEpoch"
  AND s.snapshot->>'markerId'=m.id AND s.snapshot->>'cartId'=o."cartId"
  AND s.snapshot->>'productId'=o."productId" AND s.snapshot->>'customerId'=o."customerId"
  AND s.snapshot->'ownersBefore' @> jsonb_build_array(jsonb_build_object('id',o.id,'state','ACTIVE'))
  AND s.snapshot->'ownersAfter' @> jsonb_build_array(jsonb_build_object('id',o.id,'state','RELEASE_PENDING'))
  AND (s.snapshot->'after'->>'generation')::integer=c."intentGeneration"
  AND (s.snapshot->'after'->>'mutationVersion')::integer=c."expectedMutationVersion"
  AND i.acknowledgement IS NOT NULL AND i."acknowledgementHash"=encode(sha256(convert_to(i.acknowledgement,'UTF8')),'hex')
  AND (i.acknowledgement::jsonb->'scopes') @> jsonb_build_array(jsonb_build_object('scope',s.scope,'previousRevision',s."previousRevision",'revision',s.revision))
  AND (CASE WHEN c.reason='RETIREMENT' THEN EXISTS (
   SELECT 1 FROM reservation_fence_transitions f WHERE f.id=c."causeTransitionId" AND f.phase='DRAINING'
    AND f.status='ACKNOWLEDGED' AND f.incarnation=o.incarnation AND f.epoch=o."reservationExecutionEpoch")
   ELSE s.snapshot->'after'->'quantity'='null'::jsonb END),false)
  THEN RAISE EXCEPTION 'release publication scope rejected'; END IF;
 RETURN jsonb_build_object('commandId',c.id,'replayId',c."replayId",'markerId',m.id,'version',1,
  'globalRevision',CASE WHEN creating THEN g."publishedRevision" ELSE b."globalRevision" END,
  'markerRevision',s.revision,'incarnation',o.incarnation,'epoch',o."reservationExecutionEpoch");
END $$;

CREATE FUNCTION ordinary_release_dispatchable(command_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE b jsonb; c ordinary_reservation_commands%ROWTYPE; o ordinary_reservation_owners%ROWTYPE;
 h ordinary_invalidation_heads%ROWTYPE; k text; expected_revision integer;
BEGIN
 b=ordinary_release_binding(command_id,false);
 SELECT * INTO c FROM ordinary_reservation_commands WHERE id=command_id;
 SELECT * INTO o FROM ordinary_reservation_owners WHERE id=c."ownerId";
 IF o.state<>'RELEASE_PENDING' THEN RAISE EXCEPTION 'release owner not pending'; END IF;
 FOR k,expected_revision IN SELECT 'GLOBAL',(b->>'globalRevision')::integer UNION ALL SELECT 'MARKER:'||c."markerId",(b->>'markerRevision')::integer LOOP
  SELECT * INTO h FROM ordinary_invalidation_heads WHERE scope=k FOR UPDATE;
  IF NOT COALESCE(h."pendingIntentId" IS NULL AND h."allocatedRevision"=expected_revision AND h."publishedRevision"=expected_revision
   AND h.incarnation=o.incarnation AND h.epoch=o."reservationExecutionEpoch" AND EXISTS (
    SELECT 1 FROM ordinary_invalidation_scopes s JOIN ordinary_invalidation_intents i ON i.id=s."intentId"
    WHERE s.scope=k AND s.revision=expected_revision AND i.status='PUBLISHED' AND i.acknowledgement IS NOT NULL),false)
   THEN RAISE EXCEPTION 'release publication superseded or incomplete'; END IF;
 END LOOP;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION ordinary_invalidation_bind_command() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE g ordinary_invalidation_heads%ROWTYPE; m ordinary_invalidation_heads%ROWTYPE; o ordinary_reservation_owners%ROWTYPE; b jsonb;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM ordinary_invalidation_heads WHERE scope='MARKER:'||NEW."markerId") THEN RETURN NEW; END IF;
 IF NEW.effect='RELEASE' THEN
  b=ordinary_release_binding(NEW.id,true);
  INSERT INTO ordinary_command_barrier_bindings SELECT * FROM jsonb_populate_record(NULL::ordinary_command_barrier_bindings,b);
  RETURN NEW;
 END IF;
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

CREATE OR REPLACE FUNCTION ordinary_invalidation_binding_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE c ordinary_reservation_commands%ROWTYPE; o ordinary_reservation_owners%ROWTYPE;
BEGIN
 SELECT * INTO c FROM ordinary_reservation_commands WHERE id=NEW."commandId" AND xmin=txid_current()::text::xid;
 IF c.effect='RELEASE' THEN
  IF to_jsonb(NEW) IS DISTINCT FROM ordinary_release_binding(c.id,true) THEN RAISE EXCEPTION 'release resulting binding mismatch'; END IF;
  RETURN NEW;
 END IF;
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

CREATE FUNCTION ordinary_release_consistency() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE c ordinary_reservation_commands%ROWTYPE; owner_state "OrdinaryOwnerState";
BEGIN
 SELECT * INTO c FROM ordinary_reservation_commands WHERE id=NEW.id;
 IF c.effect<>'RELEASE' OR NOT EXISTS (SELECT 1 FROM ordinary_invalidation_heads WHERE scope='MARKER:'||c."markerId") THEN RETURN NULL; END IF;
 PERFORM ordinary_release_binding(c.id,false);
 SELECT state INTO owner_state FROM ordinary_reservation_owners WHERE id=c."ownerId";
 IF owner_state IS DISTINCT FROM (CASE WHEN c.state='ACKNOWLEDGED' THEN 'CONSUMED' ELSE 'RELEASE_PENDING' END)::"OrdinaryOwnerState"
  THEN RAISE EXCEPTION 'release lifecycle mismatch'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ordinary_release_consistency AFTER INSERT OR UPDATE ON ordinary_reservation_commands
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ordinary_release_consistency();

CREATE FUNCTION ordinary_release_dispatch_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
 IF NEW.effect='RELEASE' AND EXISTS (SELECT 1 FROM ordinary_invalidation_heads WHERE scope='MARKER:'||NEW."markerId")
  AND ((OLD.state='WAITING' AND NEW.state='PENDING') OR NEW."attemptCount">OLD."attemptCount") THEN
  PERFORM ordinary_release_dispatchable(NEW.id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ordinary_release_dispatch_guard BEFORE UPDATE ON ordinary_reservation_commands
 FOR EACH ROW EXECUTE FUNCTION ordinary_release_dispatch_guard();

CREATE FUNCTION ordinary_release_truncate_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM ordinary_invalidation_heads) THEN RAISE EXCEPTION 'enrolled protocol cannot be truncated'; END IF;
 RETURN NULL;
END $$;
DO $$
DECLARE relation_name text; installed_schema text := current_schema(); signature text;
BEGIN
 FOREACH relation_name IN ARRAY ARRAY['ordinary_reservation_owners','ordinary_reservation_commands','cart_reservation_sync_states',
  'ordinary_invalidation_intents','ordinary_invalidation_scopes','ordinary_invalidation_heads','ordinary_command_barrier_bindings',
  'carts','cart_items','reservation_fence_transitions','reservation_engine_mode_configs'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION %I.ordinary_release_truncate_guard()','z_ordinary_release_truncate_'||relation_name,installed_schema,relation_name,installed_schema);
 END LOOP;
 FOREACH signature IN ARRAY ARRAY['ordinary_release_hold_identity(text,integer)','ordinary_release_binding(uuid,boolean)','ordinary_release_dispatchable(uuid)',
  'ordinary_invalidation_bind_command()','ordinary_invalidation_binding_guard()','ordinary_release_consistency()',
  'ordinary_release_dispatch_guard()','ordinary_release_truncate_guard()'] LOOP
  EXECUTE format('ALTER FUNCTION %I.%s SET search_path TO pg_catalog, %I, pg_temp',installed_schema,signature,installed_schema);
 END LOOP;
END $$;
