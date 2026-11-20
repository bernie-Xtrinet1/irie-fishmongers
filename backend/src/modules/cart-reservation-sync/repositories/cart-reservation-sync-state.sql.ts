export const UPSERT_DESIRED_STATE_SQL = `
  INSERT INTO "cart_reservation_sync_states" (
    "id", "cartId", "productId", "expectedMutationVersion", "expectedQuantity",
    "status", "blockReason", "nextAttemptAt", "resolvedAt", "lastError",
    "createdAt", "updatedAt"
  )
  VALUES (
    $1, $2, $3, $4, $5,
    'PENDING'::"CartReservationSyncStatus", NULL, NULL, NULL, NULL,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT ("cartId", "productId") DO UPDATE SET
    "expectedMutationVersion" = EXCLUDED."expectedMutationVersion",
    "expectedQuantity" = EXCLUDED."expectedQuantity",
    "generation" = "cart_reservation_sync_states"."generation" + 1,
    "status" = CASE
      WHEN "cart_reservation_sync_states"."status" = 'BLOCKED'::"CartReservationSyncStatus"
        AND "cart_reservation_sync_states"."blockReason" = 'PRODUCT_SUSPECT'::"CartReservationSyncBlockReason"
        THEN 'BLOCKED'::"CartReservationSyncStatus"
      ELSE 'PENDING'::"CartReservationSyncStatus"
    END,
    "blockReason" = CASE
      WHEN "cart_reservation_sync_states"."status" = 'BLOCKED'::"CartReservationSyncStatus"
        AND "cart_reservation_sync_states"."blockReason" = 'PRODUCT_SUSPECT'::"CartReservationSyncBlockReason"
        THEN 'PRODUCT_SUSPECT'::"CartReservationSyncBlockReason"
      ELSE NULL
    END,
    "nextAttemptAt" = CASE
      WHEN "cart_reservation_sync_states"."status" = 'BLOCKED'::"CartReservationSyncStatus"
        AND "cart_reservation_sync_states"."blockReason" = 'PRODUCT_SUSPECT'::"CartReservationSyncBlockReason"
        THEN "cart_reservation_sync_states"."nextAttemptAt"
      ELSE NULL
    END,
    "resolvedAt" = NULL,
    "lastError" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
  RETURNING "generation"
`;
