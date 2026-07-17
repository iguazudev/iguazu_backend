-- Contador de consultas fallidas a getStatus.
-- IF NOT EXISTS evita romper deploys donde la columna ya fue creada manualmente.
ALTER TABLE "Invoice"
ADD COLUMN IF NOT EXISTS "statusConsultas" INTEGER NOT NULL DEFAULT 0;
