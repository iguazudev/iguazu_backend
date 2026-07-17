-- Resumen Diario de Boletas: campos para el envío asíncrono (sendSummary/getStatus).
-- Solo aplican a boletas (invoiceType '03'); el resto de comprobantes los deja en NULL.

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "ticket"             TEXT;
ALTER TABLE "Invoice" ADD COLUMN "summaryStatus"      TEXT;
ALTER TABLE "Invoice" ADD COLUMN "summarySentAt"      TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN "summaryCorrelativo" INTEGER;

-- Índice para que el cron/busqueda de boletas pendientes de procesar sea eficiente.
CREATE INDEX "Invoice_ticket_idx" ON "Invoice"("ticket");
CREATE INDEX "Invoice_summaryStatus_idx" ON "Invoice"("summaryStatus");
