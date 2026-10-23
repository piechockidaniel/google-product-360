import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import { HttpError, SESSION_COOKIE } from '../server.js';

const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });
const passwordSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8) });

const MAX_FAILED = 10;
const WINDOW_MS = 15 * 60_000;

/** Very small brute-force protection: max 10 failed logins per IP per 15 minutes (per server instance). */
class LoginThrottle {
  private readonly failed = new Map<string, { count: number; resetAt: number }>();

  check(ip: string): void {
    const entry = this.failed.get(ip);
    if (entry && entry.resetAt > Date.now() && entry.count >= MAX_FAILED) {
      throw new HttpError(429, 'Too many failed login attempts, try again later');
    }
  }

  fail(ip: string): void {
    const entry = this.failed.get(ip);
    if (!entry || entry.resetAt < Date.now()) this.failed.set(ip, { count: 1, resetAt: Date.now() + WINDOW_MS });
    else entry.count += 1;
  }

  succeed(ip: string): void {
    this.failed.delete(ip);
  }
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const throttle = new LoginThrottle();
  app.get('/auth/providers', async () => ({
    google: ctx.oauth.configured,
    local: ctx.config.LOCAL_LOGIN_ENABLED || ctx.config.DEMO_MODE,
    demo: ctx.config.DEMO_MODE,
  }));

  app.get('/auth/google/start', async (_request, reply) => {
    if (!ctx.oauth.configured) throw new HttpError(503, 'Google OAuth is not configured on this installation');
    const started = ctx.oauth.start();
    ctx.auth.createOAuthState(started.state, started.codeVerifier);
    return reply.redirect(started.url);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/auth/google/callback', async (request, reply) => {
    if (request.query.error) return reply.redirect('/?auth_error=google_denied');
    if (!request.query.code || !request.query.state) return reply.redirect('/?auth_error=google_invalid_callback');
    const verifier = ctx.auth.consumeOAuthState(request.query.state);
    if (!verifier) return reply.redirect('/?auth_error=google_expired');
    try {
      const identity = await ctx.oauth.exchange(request.query.code, verifier);
      const session = ctx.auth.loginGoogle(identity.sub, identity.email, identity.name);
      reply.setCookie(SESSION_COOKIE, session.id, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: ctx.config.NODE_ENV === 'production' && (ctx.settings.current().publicUrl?.startsWith('https://') ?? false),
        signed: true,
        expires: new Date(session.expiresAt),
      });
      ctx.events.record('auth.google_login', `Google user ${identity.email} logged in`, { payload: { email: identity.email } });
      return reply.redirect('/');
    } catch (err) {
      ctx.logger.warn({ err }, 'Google OAuth callback failed');
      return reply.redirect('/?auth_error=google_failed');
    }
  });

  app.post('/auth/login', async (request, reply) => {
    if (!ctx.config.LOCAL_LOGIN_ENABLED && !ctx.config.DEMO_MODE) throw new HttpError(404, 'Local password login is disabled');
    throttle.check(request.ip);
    const { username, password } = loginSchema.parse(request.body);
    const session = ctx.auth.login(username, password);
    if (!session) {
      throttle.fail(request.ip);
      throw new HttpError(401, 'Invalid username or password');
    }
    throttle.succeed(request.ip);
    ctx.events.record('auth.login', `User ${username} logged in`);
    reply.setCookie(SESSION_COOKIE, session.id, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.config.NODE_ENV === 'production' && (ctx.settings.current().publicUrl?.startsWith('https://') ?? false),
      signed: true,
      expires: new Date(session.expiresAt),
    });
    return { user: session.user };
  });

  app.post('/auth/logout', async (request, reply) => {
    if (request.session) ctx.auth.logout(request.session.id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', async (request) => {
    if (!request.session) throw new HttpError(401, 'Not authenticated');
    return { user: request.session.user, mock: ctx.settings.current().mock, demo: ctx.config.DEMO_MODE, configured: ctx.settings.isConfigured(), setupCompleted: !!ctx.settings.current().setupCompletedAt, accountId: ctx.api.accountId };
  });

  /** Resets the "since last login" marker to now. */
  app.post('/auth/acknowledge', async (request) => {
    if (!request.session) throw new HttpError(401, 'Not authenticated');
    const user = ctx.auth.acknowledge(request.session.user.id);
    return { user };
  });

  app.post('/auth/password', async (request) => {
    if (!request.session) throw new HttpError(401, 'Not authenticated');
    const { currentPassword, newPassword } = passwordSchema.parse(request.body);
    if (!ctx.auth.verifyCredentials(request.session.user.username, currentPassword)) throw new HttpError(400, 'Current password is incorrect');
    ctx.auth.changePassword(request.session.user.id, newPassword);
    return { ok: true };
  });
}
