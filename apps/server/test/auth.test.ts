import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PASSWORD, createTestEnv, login, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

describe('authentication', () => {
  it('logs in and returns permissions scoped by role', async () => {
    const res = await request(env.app).post('/api/auth/login').send({ username: 'B1CASH', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('b1cash');
    expect(res.body.user.permissions).toContain('pos.sell');
    expect(res.body.user.permissions).not.toContain('users.manage');
    expect(res.body.user.locationIds).toEqual([env.ids.b1]);
    expect(JSON.stringify(res.body)).not.toContain('scrypt');
  });

  it('rejects bad credentials without revealing which part was wrong', async () => {
    const a = await request(env.app).post('/api/auth/login').send({ username: 'b1cash', password: 'wrong-pass1' });
    const b = await request(env.app).post('/api/auth/login').send({ username: 'nobody', password: 'wrong-pass1' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('locks the account after repeated failures', async () => {
    for (let i = 0; i < 5; i++) {
      await request(env.app).post('/api/auth/login').send({ username: 'accounts', password: 'bad-pass-1' });
    }
    const res = await request(env.app).post('/api/auth/login').send({ username: 'accounts', password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/locked/i);
  });

  it('requires a valid token and invalidates old tokens after password change', async () => {
    expect((await request(env.app).get('/api/auth/me')).status).toBe(401);
    expect((await request(env.app).get('/api/auth/me').set('Authorization', 'Bearer garbage')).status).toBe(401);
    const token = await login(env.app, 'b2cash');
    expect((await request(env.app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    const weak = await request(env.app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: PASSWORD, newPassword: 'short' });
    expect(weak.status).toBe(400);
    const changed = await request(env.app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: PASSWORD, newPassword: 'NewPassw0rd' });
    expect(changed.status).toBe(200);
    expect((await request(env.app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect((await request(env.app).get('/api/auth/me').set('Authorization', `Bearer ${changed.body.accessToken}`)).status).toBe(200);
  });

  it('enforces role permissions on admin endpoints', async () => {
    const cashier = await login(env.app, 'b1cash');
    const res = await request(env.app).get('/api/users').set('Authorization', `Bearer ${cashier}`);
    expect(res.status).toBe(403);
    const admin = await login(env.app, 'admin');
    const ok = await request(env.app).get('/api/users').set('Authorization', `Bearer ${admin}`);
    expect(ok.status).toBe(200);
    expect(ok.body.length).toBeGreaterThan(3);
  });

  it('rejects requests with invalid device keys', async () => {
    const res = await request(env.app).get('/api/sync/pull').set('X-Device-Key', '00000000-0000-0000-0000-000000000000.nope');
    expect(res.status).toBe(401);
  });
});
