import { createHash, randomBytes } from 'node:crypto';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';

export const GOOGLE_OIDC_SCOPES = ['openid', 'email', 'profile'] as const;

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string | undefined;
}

export interface OAuthStart {
  state: string;
  codeVerifier: string;
  url: string;
}

/** Server-side Google OIDC flow. Merchant API credentials are intentionally not part of this flow. */
export class GoogleOAuthService {
  constructor(
    private readonly clientId: string | undefined,
    private readonly clientSecret: string | undefined,
    private readonly redirectUri: string | undefined,
  ) {}

  get configured(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.redirectUri);
  }

  start(): OAuthStart {
    if (!this.configured) throw new Error('Google OAuth is not configured');
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const client = this.client();
    const url = client.generateAuthUrl({
      access_type: 'online',
      prompt: 'select_account',
      scope: [...GOOGLE_OIDC_SCOPES],
      state,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });
    return { state, codeVerifier, url };
  }

  async exchange(code: string, codeVerifier: string): Promise<GoogleIdentity> {
    const client = this.client();
    const { tokens } = await client.getToken({ code, codeVerifier });
    if (!tokens.id_token) throw new Error('Google did not return an identity token');
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: this.clientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email || payload.email_verified === false) throw new Error('Google account identity is missing a verified e-mail address');
    return { sub: payload.sub, email: payload.email, name: payload.name };
  }

  private client(): OAuth2Client {
    if (!this.configured) throw new Error('Google OAuth is not configured');
    return new OAuth2Client(this.clientId, this.clientSecret, this.redirectUri);
  }
}
