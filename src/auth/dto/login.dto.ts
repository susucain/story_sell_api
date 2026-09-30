import { Transform, TransformFnParams } from 'class-transformer';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import {
  ACCOUNT_ERROR_MESSAGE,
  ACCOUNT_PATTERN,
  normalizeAccount,
} from '../account';

export class LoginDto {
  @Transform(({ value }: TransformFnParams) => {
    return normalizeAccount(value);
  })
  @IsString()
  @IsNotEmpty()
  @Matches(ACCOUNT_PATTERN, {
    message: ACCOUNT_ERROR_MESSAGE,
  })
  account: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password: string;
}
