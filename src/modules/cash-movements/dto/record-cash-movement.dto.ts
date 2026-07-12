import {
  CashMovementCategory,
  CashMovementType,
  PaymentMethod,
  UserRole,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class RecordCashMovementDto {
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  cashShiftId?: number;

  @Type(() => Number)
  @IsInt()
  userId!: number;

  @IsEnum(CashMovementType)
  type!: CashMovementType;

  @IsEnum(CashMovementCategory)
  category!: CashMovementCategory;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  referenceType?: string;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  referenceId?: number;

  actorRole?: UserRole;
}
