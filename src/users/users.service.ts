import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  create(createUserDto: CreateUserDto) {
    return this.usersRepository.save(createUserDto);
  }

  findAll() {
    return this.usersRepository.find();
  }

  findOne(id: number) {
    return this.usersRepository.findOne({ where: { id } });
  }

  findByAccount(account: string) {
    return this.usersRepository.findOne({ where: { account } });
  }

  createAccount(credentials: { account: string; passwordHash: string }) {
    return this.usersRepository.save({
      ...credentials,
      status: 'active',
    });
  }

  findAuthUserById(id: number) {
    return this.usersRepository.findOne({ where: { id } });
  }

  incrementTokenVersion(id: number) {
    return this.usersRepository.increment({ id }, 'tokenVersion', 1);
  }

  recordLogin(id: number, lastLoginAt: Date) {
    return this.usersRepository.update(id, { lastLoginAt });
  }

  update(id: number, updateUserDto: UpdateUserDto) {
    return this.usersRepository.update(id, updateUserDto);
  }

  remove(id: number) {
    return this.usersRepository.delete(id);
  }
}
