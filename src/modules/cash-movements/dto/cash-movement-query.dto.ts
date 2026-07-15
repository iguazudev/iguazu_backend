import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class CashMovementQueryDto {
  @IsString()
  @IsOptional()
  openedDate?: string;

  @IsIn(['DAY', 'NIGHT'])
  @IsOptional()
  workShift?: 'DAY' | 'NIGHT';

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  cashShiftId?: number;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  userId?: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  @IsOptional()
  limit?: number;
}
