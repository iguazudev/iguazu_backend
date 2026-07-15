import { IsOptional, IsString } from 'class-validator';

export class CashShiftQueryDto {
  @IsString()
  @IsOptional()
  openedDate?: string;
}
