import { describe, it, expect } from 'vitest';
import { withRollback, expectQueryError } from './helpers';

describe('Test Helpers Validation', () => {
  it('expectQueryError fails when statement unexpectedly succeeds', async () => {
    await withRollback(async (client) => {
      let failedAsExpected = false;
      try {
        await expectQueryError(client, 'SELECT 1 AS success_test', [], /some error/);
      } catch (err: unknown) {
        failedAsExpected = true;
        expect((err as Error).message).toContain('Expected statement to fail');
      }
      expect(failedAsExpected).toBe(true);
    });
  });

  it('expectQueryError fails when error does not match the expected pattern', async () => {
    await withRollback(async (client) => {
      let failedAsExpected = false;
      try {
        await expectQueryError(
          client,
          'INSERT INTO department (department_name, department_code) VALUES (NULL, $1)',
          ['TEST_DEPT'],
          /PATTERN_THAT_WILL_NOT_MATCH/
        );
      } catch (err: unknown) {
        failedAsExpected = true;
        expect((err as Error).message).not.toContain('Expected statement to fail');
      }
      expect(failedAsExpected).toBe(true);
    });
  });

  it('expectQueryError succeeds when query fails with matching pattern', async () => {
    await withRollback(async (client) => {
      await expectQueryError(
        client,
        'INSERT INTO department (department_name, department_code) VALUES (NULL, $1)',
        ['TEST_DEPT'],
        /null value in column "department_name"/i
      );
    });
  });
});
