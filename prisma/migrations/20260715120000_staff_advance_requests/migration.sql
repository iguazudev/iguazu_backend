CREATE TYPE "StaffAdvanceStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "StaffAdvance"
ADD COLUMN "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'CASH',
ADD COLUMN "status" "StaffAdvanceStatus" NOT NULL DEFAULT 'APPROVED',
ADD COLUMN "reviewedAt" TIMESTAMP(3),
ADD COLUMN "reviewNote" TEXT;

ALTER TABLE "StaffAdvance"
ALTER COLUMN "status" SET DEFAULT 'PENDING';
