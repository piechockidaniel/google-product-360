/**
 * Creates (or resets the password of) a local user.
 *   npm run user:add -- <username> <password>
 */
import { loadConfig } from '../config/index.js';
import { Database } from '../db/database.js';
import { AuthService } from '../services/auth-service.js';

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: npm run user:add -- <username> <password>');
  process.exit(1);
}
const config = loadConfig({ ...process.env, MERCHANT_MOCK: process.env.MERCHANT_MOCK ?? 'true' });
const db = new Database(config.DATABASE_PATH);
const auth = new AuthService(db, config.SESSION_TTL_HOURS);
const existing = auth.getUserByUsername(username);
if (existing) {
  auth.changePassword(existing.id, password);
  console.log(`Password of user "${username}" updated.`);
} else {
  auth.createUser(username, password);
  console.log(`User "${username}" created.`);
}
db.close();
