import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CancelSaleDto {
  @IsString()
  @IsNotEmpty()
  reason!: string;

  @IsString()
  @IsOptional()
  voidReason?: string;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  cashShiftId?: number;
}
