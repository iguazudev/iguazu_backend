import { PaymentMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateStaffAdvanceDto {
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  employeeId?: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsString()
  @IsOptional()
  reason?: string;

  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;
}
