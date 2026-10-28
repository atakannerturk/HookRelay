import { execSync } from 'node:child_process';
import { TEST_DATABASE_URL } from './test-env';

/** Creates the test database (if missing) and applies the migrations. */
export default function globalSetup(): void {
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  });
}
