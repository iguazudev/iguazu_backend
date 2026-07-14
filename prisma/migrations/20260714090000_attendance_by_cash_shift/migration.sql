-- Asistencia por turno/caja.
-- Permite varios turnos del mismo empleado en un día y vincula cada asistencia
-- a la caja que abrió.
ALTER TABLE "Attendance" ADD COLUMN "cashShiftId" INTEGER;

DROP INDEX IF EXISTS "Attendance_employeeId_date_key";

CREATE INDEX IF NOT EXISTS "Attendance_employeeId_date_idx"
  ON "Attendance"("employeeId", "date");

CREATE UNIQUE INDEX IF NOT EXISTS "Attendance_cashShiftId_key"
  ON "Attendance"("cashShiftId");

CREATE INDEX IF NOT EXISTS "Attendance_cashShiftId_idx"
  ON "Attendance"("cashShiftId");

ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_cashShiftId_fkey"
  FOREIGN KEY ("cashShiftId") REFERENCES "CashShift"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
