import { IsEmail, IsNotEmpty, MaxLength } from 'class-validator';

export class UpdateUserDto {
  @IsNotEmpty()
  @MaxLength(50)
  name: string;

  @IsNotEmpty()
  @IsEmail()
  @MaxLength(50)
  email: string;
}
