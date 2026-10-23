import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import { MerchantApiError } from '../../google/rest-client.js';
import { merchantSettingsSchema, parseServiceAccount } from '../../services/settings-service.js';
import { HttpError } from '../server.js';

const adminSchema = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(8) });

/** Partial update; `serviceAccountJson` may be omitted to keep the stored key. */
const updateSchema = merchantSettingsSchema.partial().extend({
  serviceAccountJson: z.string().nullable().optional(),
});

const testSchema = z.object({
  mock: z.boolean().default(false),
  merchantAccountId: z.string().trim().default(''),
  /** omit / null to test with the stored key */
  serviceAccountJson: z.string().nullable().optional(),
  apiBaseUrl: z.string().url().optional(),
  apiVersion: z.string().optional(),
});

/** Google's message when the GCP project has not been registered as a developer with the account. */
export const NOT_REGISTERED_RE = /not registered with the merchant account|register the GCP project|developer registration/i;

/** English hint texts; the UI translates by `hintCode` and falls back to these. */
const HINTS: Record<string, string> = {
  not_registered:
    'The Google Cloud project of this service account is not yet registered as a developer with the Merchant Center account. Use "Register Google Cloud project" below (one-time step), then test again after a few minutes.',
  unauthorized: 'Google rejected the credentials. Check that the key belongs to an active service account and that the Merchant API is enabled in the Google Cloud project.',
  forbidden: 'Access denied. Add the service-account e-mail as a user of the Merchant Center account (Settings → People and access) and make sure the Merchant API is enabled in the Google Cloud project.',
  not_found: 'The account was not found. Check the Merchant Center account id (the number in the top-right corner of Merchant Center).',
  quota: 'Quota exceeded – try again in a moment.',
  server: 'Google returned a server error – try again later.',
  network: 'Network error – the server cannot reach merchantapi.googleapis.com.',
  bad_key: 'The private key in the service account JSON is invalid.',
  account_required: 'Enter the numeric account id.',
  key_required: 'Paste or upload the JSON key file.',
  key_invalid: 'Download a JSON key for the service account in Google Cloud → IAM → Service accounts → Keys.',
  registration_conditions:
    'Registration is only possible when: (1) the service-account e-mail is added as a user directly on this Merchant Center account (not only on a parent/advanced account), ' +
    '(2) the account is a production account – not a test account, (3) the website of the account is verified & claimed in Merchant Center, ' +
    '(4) the developer e-mail belongs to a real Google account that is an admin of the Merchant Center account.',
};

function hintCodeFor(err: unknown): string | null {
  if (err instanceof MerchantApiError) {
    if (NOT_REGISTERED_RE.test(err.message)) return 'not_registered';
    switch (err.status) {
      case 401:
        return 'unauthorized';
      case 403:
        return 'forbidden';
      case 404:
        return 'not_found';
      case 429:
        return 'quota';
      default:
        return err.status >= 500 ? 'server' : null;
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/ENOTFOUND|ECONN|fetch failed/i.test(message)) return 'network';
  if (/invalid_grant|DECODER|PEM/i.test(message)) return 'bad_key';
  return null;
}

function hintFor(err: unknown): string {
  const code = hintCodeFor(err);
  if (code) return HINTS[code]!;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Setup wizard endpoints. `/setup/status` and `/setup/admin` are public (the
 * latter only works while no user exists); everything else needs a session.
 */
export function registerSetupRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/setup/status', async () => ({
    needsAdmin: ctx.auth.userCount() === 0,
    configured: ctx.settings.isConfigured(),
    setupCompleted: !!ctx.settings.current().setupCompletedAt,
    mock: ctx.settings.current().mock,
    demo: ctx.config.DEMO_MODE,
  }));

  app.post('/setup/admin', async (request, reply) => {
    if (ctx.auth.userCount() > 0) throw new HttpError(409, 'An administrator already exists – please log in');
    const { username, password } = adminSchema.parse(request.body);
    const user = ctx.auth.createUser(username, password);
    ctx.events.record('auth.user_created', `Administrator "${username}" created by the setup wizard`);
    return reply.status(201).send({ user });
  });

  app.register(async (secured) => {
    secured.addHook('preHandler', async (request) => {
      if (!request.session) throw new HttpError(401, 'Authentication required');
    });

    secured.get('/setup/config', async () => ctx.settings.publicView());

    secured.put('/setup/config', async (request) => {
      const patch = updateSchema.parse(request.body);
      if (patch.serviceAccountJson === undefined) delete patch.serviceAccountJson;
      try {
        ctx.settings.update(patch);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
      ctx.events.record('settings.updated', `Settings updated: ${Object.keys(patch).join(', ')}`, { payload: Object.keys(patch) });
      return ctx.settings.publicView();
    });

    /** Validates a service account key without storing it. */
    secured.post('/setup/inspect-key', async (request) => {
      const { serviceAccountJson } = z.object({ serviceAccountJson: z.string() }).parse(request.body);
      try {
        return parseServiceAccount(serviceAccountJson);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
    });

    /** Tries the given (or stored) credentials against Google and reports what it found. */
    secured.post('/setup/test-connection', async (request) => {
      const body = testSchema.parse(request.body);
      const current = ctx.settings.current();
      const candidate = merchantSettingsSchema.parse({
        ...current,
        mock: body.mock,
        merchantAccountId: body.merchantAccountId,
        serviceAccountJson: body.serviceAccountJson === undefined ? current.serviceAccountJson : body.serviceAccountJson,
        apiBaseUrl: body.apiBaseUrl ?? current.apiBaseUrl,
        apiVersion: body.apiVersion ?? current.apiVersion,
      });
      if (!candidate.mock) {
        if (!candidate.merchantAccountId) return { ok: false, error: 'Merchant account id is required', hint: HINTS.account_required, hintCode: 'account_required' };
        if (!candidate.serviceAccountJson) return { ok: false, error: 'Service account key is required', hint: HINTS.key_required, hintCode: 'key_required' };
        try {
          parseServiceAccount(candidate.serviceAccountJson);
        } catch (err) {
          return { ok: false, error: (err as Error).message, hint: HINTS.key_invalid, hintCode: 'key_invalid' };
        }
      }
      const api = ctx.buildApi(candidate);
      const started = Date.now();
      try {
        const account = await api.getAccount();
        let dataSources = 0;
        let productPage = 0;
        let warnings: string[] = [];
        try {
          dataSources = (await api.listDataSources()).length;
        } catch (err) {
          warnings.push(`Data sources could not be listed: ${hintFor(err)}`);
        }
        try {
          for await (const page of api.listProductPages(1)) {
            productPage = page.length;
            break;
          }
        } catch (err) {
          warnings.push(`Products could not be listed: ${hintFor(err)}`);
        }
        return {
          ok: true,
          account,
          dataSources,
          hasProducts: productPage > 0,
          warnings,
          durationMs: Date.now() - started,
        };
      } catch (err) {
        ctx.logger.warn({ err }, 'Connection test failed');
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          status: err instanceof MerchantApiError ? err.status : undefined,
          hint: hintFor(err),
          hintCode: hintCodeFor(err),
          needsRegistration: err instanceof MerchantApiError && NOT_REGISTERED_RE.test(err.message),
        };
      }
    });

    /**
     * One-time developer registration: links the Google Cloud project that owns
     * the service account to the Merchant Center account (Merchant API requirement).
     */
    secured.post('/setup/register-gcp', async (request) => {
      const body = testSchema.extend({ developerEmail: z.string().email() }).parse(request.body);
      const current = ctx.settings.current();
      const candidate = merchantSettingsSchema.parse({
        ...current,
        mock: body.mock,
        merchantAccountId: body.merchantAccountId,
        serviceAccountJson: body.serviceAccountJson === undefined ? current.serviceAccountJson : body.serviceAccountJson,
        apiBaseUrl: body.apiBaseUrl ?? current.apiBaseUrl,
        apiVersion: body.apiVersion ?? current.apiVersion,
      });
      if (!candidate.mock && (!candidate.merchantAccountId || !candidate.serviceAccountJson)) {
        throw new HttpError(400, 'Account id and service account key are required first');
      }
      const api = ctx.buildApi(candidate);
      try {
        const registration = await api.registerGcp(body.developerEmail);
        ctx.events.record('settings.gcp_registered', `Registered Google Cloud project with Merchant Center account ${candidate.merchantAccountId}`, { payload: registration });
        return { ok: true, registration, message: 'Registered. Google needs up to 5 minutes before API calls from this project are accepted – then run "Test connection" again.' };
      } catch (err) {
        ctx.logger.warn({ err }, 'Developer registration failed');
        const message = err instanceof Error ? err.message : String(err);
        let hint = hintFor(err);
        let hintCode = hintCodeFor(err);
        if (err instanceof MerchantApiError && (err.status === 403 || err.status === 400)) {
          hintCode = 'registration_conditions';
          hint = HINTS.registration_conditions!;
        }
        return { ok: false, error: message, hint, hintCode };
      }
    });

    secured.post('/setup/generate-secret', async () => ({ secret: randomBytes(18).toString('base64url') }));

    /** Marks the wizard as finished and kicks off the first sync. */
    secured.post('/setup/complete', async () => {
      if (!ctx.settings.isConfigured()) throw new HttpError(400, 'Connection is not configured yet');
      ctx.settings.update({ setupCompletedAt: new Date().toISOString() });
      ctx.events.record('settings.setup_completed', 'Setup wizard completed');
      const syncPromise = ctx.sync.runFullSync('setup');
      syncPromise.catch(() => undefined);
      return { ok: true, syncStarted: true };
    });
  });
}
