import { SignJWT, jwtVerify } from 'jose';

export interface AccessClaims {
  sub: string;
  ver: number;
}

export class TokenService {
  private key: Uint8Array;
  constructor(secret: string, private ttlMinutes: number) {
    this.key = new TextEncoder().encode(secret);
  }

  async issue(userId: string, tokenVersion: number): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + this.ttlMinutes * 60_000);
    const token = await new SignJWT({ ver: tokenVersion, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setIssuer('store-central')
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.key);
    return { token, expiresAt };
  }

  async verify(token: string): Promise<AccessClaims> {
    const { payload } = await jwtVerify(token, this.key, { issuer: 'store-central', algorithms: ['HS256'] });
    if (payload.typ !== 'access' || typeof payload.sub !== 'string' || typeof payload.ver !== 'number') {
      throw new Error('Invalid token');
    }
    return { sub: payload.sub, ver: payload.ver };
  }
}
