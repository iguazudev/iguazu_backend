import { PaymentMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString } from 'class-validator';

export class ReviewStaffAdvanceDto {
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  cashShiftId?: number;

  @IsEnum(PaymentMethod)
  @IsOptional()
  paymentMethod?: PaymentMethod;

  @IsString()
  @IsOptional()
  note?: string;
}
