-- CreateIndex
CREATE INDEX "checkout_attempts_status_lastHeartbeatAt_id_idx" ON "checkout_attempts"("status", "lastHeartbeatAt", "id");
