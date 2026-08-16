-- CreateTable
CREATE TABLE "cart_mutation_barrier_configs" (
    "id" TEXT NOT NULL,
    "revision" SERIAL NOT NULL,
    "active" BOOLEAN NOT NULL,
    "activatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cart_mutation_barrier_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cart_mutation_barrier_configs_revision_key" ON "cart_mutation_barrier_configs"("revision");

-- AddForeignKey
ALTER TABLE "cart_mutation_barrier_configs" ADD CONSTRAINT "cart_mutation_barrier_configs_activatedById_fkey" FOREIGN KEY ("activatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
