import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import {
  DevelopmentAccountBootstrapService,
  PASSWORD_HASHER,
} from './development-account-bootstrap.service';
import { AuthService } from './auth.service';
import { AuthSession } from './entities/auth-session.entity';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Module({
  imports: [
    JwtModule.register({}),
    TypeOrmModule.forFeature([AuthSession]),
    UsersModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    DevelopmentAccountBootstrapService,
    JwtAuthGuard,
    {
      provide: PASSWORD_HASHER,
      useValue: bcrypt,
    },
    {
      provide: APP_GUARD,
      useExisting: JwtAuthGuard,
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
