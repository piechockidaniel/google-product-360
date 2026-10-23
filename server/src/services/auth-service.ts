import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Database, now } from '../db/database.js';

export interface User {
  id: number;
  username: string;
  email: string | null;
  googleSub: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  previousLoginAt: string | null;
}

export interface Session {
  id: string;
  user: User;
  expiresAt: string;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function rowToUser(row: Record<string, unknown>): User {
  return {
    id: Number(row.id),
    username: row.username as string,
    email: (row.email as string | null) ?? null,
    googleSub: (row.google_sub as string | null) ?? null,
    createdAt: row.created_at as string,
    lastLoginAt: (row.last_login_at as string | null) ?? null,
    previousLoginAt: (row.previous_login_at as string | null) ?? null,
  };
}

/**
 * Local username/password users with DB backed sessions. Tracks the previous
 * login timestamp per user so the UI can show "what changed since you were
 * last here".
 */
export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly sessionTtlHours: number,
  ) {}

  userCount(): number {
    return Number(this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM users')?.c ?? 0);
  }

  createUser(username: string, password: string): User {
    if (password.length < 8) throw new Error('Password must be at least 8 characters');
    this.db.run('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)', [username, hashPassword(password), now()]);
    return this.getUserByUsername(username)!;
  }

  /** Creates or updates the local shadow user for a verified Google identity. */
  loginGoogle(googleSub: string, email: string, displayName?: string): Session {
    const existing = this.db.get<{ id: number }>('SELECT id FROM users WHERE google_sub = ?', [googleSub]);
    let userId = existing?.id;
    if (!userId) {
      const byEmail = this.db.get<{ id: number }>('SELECT id FROM users WHERE email = ?', [email]);
      userId = byEmail?.id;
    }
    if (userId) {
      this.db.run('UPDATE users SET google_sub = ?, email = ? WHERE id = ?', [googleSub, email, userId]);
    } else {
      const username = this.uniqueUsername(displayName || email.split('@')[0] || 'google-user');
      this.db.run(
        'INSERT INTO users (username, password_hash, email, google_sub, created_at) VALUES (?, ?, ?, ?, ?)',
        [username, hashPassword(randomBytes(32).toString('base64url')), email, googleSub, now()],
      );
      userId = Number(this.db.get<{ id: number }>('SELECT id FROM users WHERE google_sub = ?', [googleSub])!.id);
    }
    return this.createSession(userId);
  }

  private uniqueUsername(preferred: string): string {
    const base = preferred.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'google-user';
    let candidate = base;
    let suffix = 2;
    while (this.getUserByUsername(candidate)) candidate = `${base}-${suffix++}`;
    return candidate;
  }

  changePassword(userId: number, password: string): void {
    if (password.length < 8) throw new Error('Password must be at least 8 characters');
    this.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(password), userId]);
  }

  listUsers(): User[] {
    return this.db.all('SELECT * FROM users ORDER BY id').map(rowToUser);
  }

  deleteUser(userId: number): void {
    this.db.run('DELETE FROM users WHERE id = ?', [userId]);
  }

  getUserByUsername(username: string): User | undefined {
    const row = this.db.get('SELECT * FROM users WHERE username = ?', [username]);
    return row ? rowToUser(row) : undefined;
  }

  verifyCredentials(username: string, password: string): User | undefined {
    const row = this.db.get('SELECT * FROM users WHERE username = ?', [username]);
    if (!row || !verifyPassword(password, row.password_hash as string)) return undefined;
    return rowToUser(row);
  }

  /** Validates credentials and opens a session. Shifts last_login -> previous_login. */
  login(username: string, password: string): Session | undefined {
    const row = this.db.get<{ id: number; password_hash: string; last_login_at: string | null }>('SELECT * FROM users WHERE username = ?', [username]);
    if (!row || !verifyPassword(password, row.password_hash)) return undefined;
    return this.createSession(row.id);
  }

  private createSession(userId: number): Session {
    const ts = now();
    this.db.run('UPDATE users SET previous_login_at = COALESCE(last_login_at, created_at, ?), last_login_at = ? WHERE id = ?', [ts, ts, userId]);
    const id = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.sessionTtlHours * 3600_000).toISOString();
    this.db.run('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [id, userId, ts, expiresAt]);
    return this.getSession(id)!;
  }

  createOAuthState(state: string, codeVerifier: string, ttlMs = 10 * 60_000): void {
    const createdAt = now();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.db.run('INSERT INTO oauth_states (state, code_verifier, created_at, expires_at) VALUES (?, ?, ?, ?)', [state, codeVerifier, createdAt, expiresAt]);
  }

  consumeOAuthState(state: string): string | undefined {
    const row = this.db.get<{ code_verifier: string; expires_at: string }>('SELECT code_verifier, expires_at FROM oauth_states WHERE state = ?', [state]);
    this.db.run('DELETE FROM oauth_states WHERE state = ?', [state]);
    if (!row || row.expires_at < now()) return undefined;
    return row.code_verifier;
  }

  pruneOAuthStates(): number {
    return this.db.run('DELETE FROM oauth_states WHERE expires_at < ?', [now()]).changes;
  }

  getSession(id: string): Session | undefined {
    const row = this.db.get<{ id: string; expires_at: string; user_id: number }>('SELECT * FROM sessions WHERE id = ?', [id]);
    if (!row) return undefined;
    if (row.expires_at < now()) {
      this.db.run('DELETE FROM sessions WHERE id = ?', [id]);
      return undefined;
    }
    const user = this.db.get('SELECT * FROM users WHERE id = ?', [row.user_id]);
    if (!user) return undefined;
    return { id: row.id, user: rowToUser(user), expiresAt: row.expires_at };
  }

  logout(sessionId: string): void {
    this.db.run('DELETE FROM sessions WHERE id = ?', [sessionId]);
  }

  /** Marks "now" as the user's reference point for "since last login" (without a new session). */
  acknowledge(userId: number): User {
    this.db.run('UPDATE users SET previous_login_at = ? WHERE id = ?', [now(), userId]);
    return rowToUser(this.db.get('SELECT * FROM users WHERE id = ?', [userId])!);
  }

  pruneExpiredSessions(): number {
    return this.db.run('DELETE FROM sessions WHERE expires_at < ?', [now()]).changes;
  }
}
