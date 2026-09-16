import { UsersService } from '../../../src/users/users.service';

describe('UsersService authentication lookups', () => {
  const userRepository = {
    delete: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('looks up a user by account with a repository where clause', async () => {
    const service = new UsersService(userRepository as never);

    await service.findByAccount('dev');

    expect(userRepository.findOne).toHaveBeenCalledWith({
      where: { account: 'dev' },
    });
  });

  it('looks up an authentication user by id with a repository where clause', async () => {
    const service = new UsersService(userRepository as never);

    await service.findAuthUserById(42);

    expect(userRepository.findOne).toHaveBeenCalledWith({
      where: { id: 42 },
    });
  });

  it('creates users through the repository', async () => {
    const service = new UsersService(userRepository as never);
    const createUserDto = { name: 'New user', email: 'new@example.com' };

    await service.create(createUserDto);

    expect(userRepository.save).toHaveBeenCalledWith(createUserDto);
  });

  it('finds all users through the repository', async () => {
    const service = new UsersService(userRepository as never);

    await service.findAll();

    expect(userRepository.find).toHaveBeenCalledWith();
  });

  it('finds one user by id through the repository', async () => {
    const service = new UsersService(userRepository as never);

    await service.findOne(7);

    expect(userRepository.findOne).toHaveBeenCalledWith({
      where: { id: 7 },
    });
  });

  it('updates users through the repository', async () => {
    const service = new UsersService(userRepository as never);
    const updateUserDto = {
      name: 'Updated user',
      email: 'updated@example.com',
    };

    await service.update(7, updateUserDto);

    expect(userRepository.update).toHaveBeenCalledWith(7, updateUserDto);
  });

  it('removes users through the repository', async () => {
    const service = new UsersService(userRepository as never);

    await service.remove(7);

    expect(userRepository.delete).toHaveBeenCalledWith(7);
  });
});
