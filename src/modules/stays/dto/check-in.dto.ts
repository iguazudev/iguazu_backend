import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  Min,
} from 'class-validator';

export class CheckInDto {
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  cashShiftId?: number;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  customerId?: number;

  @Type(() => Number)
  @IsInt()
  roomId!: number;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  reservationId?: number;

  @Type(() => Number)
  @IsInt()
  priceTypeId!: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  agreedPrice?: number;

  @IsDateString()
  @IsOptional()
  expectedCheckOut?: string;
}
