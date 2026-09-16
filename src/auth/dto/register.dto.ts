import { Transform, TransformFnParams } from 'class-transformer';
import {
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ACCOUNT_PATTERN, normalizeAccount } from '../account';

export class RegisterDto {
  @Transform(({ value }: TransformFnParams) => normalizeAccount(value))
  @IsString()
  @IsNotEmpty()
  @Matches(ACCOUNT_PATTERN, {
    message: '账号仅支持 3-64 位小写字母、数字、点、下划线或短横线',
  })
  account: string;

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  @Matches(/[a-z]/, { message: '密码必须包含小写字母' })
  @Matches(/[A-Z]/, { message: '密码必须包含大写字母' })
  @Matches(/\d/, { message: '密码必须包含数字' })
  password: string;

  @IsString()
  @IsNotEmpty()
  confirmPassword: string;
}
