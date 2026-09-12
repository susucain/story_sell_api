import { getMetadataArgsStorage } from 'typeorm';
import { User } from '../../../src/users/entities/user.entity';

describe('User entity authentication metadata', () => {
  it('uses the migration-owned unique account index', () => {
    const metadata = getMetadataArgsStorage();
    const accountIndex = metadata.indices.find(
      (index) =>
        index.target === User && index.name === 'IDX_users_account',
    );

    expect(accountIndex).toEqual(
      expect.objectContaining({
        columns: ['account'],
        unique: true,
      }),
    );
  });

  it('does not create a generated unique account constraint', () => {
    const metadata = getMetadataArgsStorage();
    const accountColumn = metadata.columns.find(
      (column) => column.target === User && column.propertyName === 'account',
    );

    expect(accountColumn?.options.unique).not.toBe(true);
  });
});
