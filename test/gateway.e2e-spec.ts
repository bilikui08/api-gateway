import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp, makeKeys, signToken, startFakeAuth } from './helpers.js';

const keys = makeKeys();
const otherKeys = makeKeys();

describe('Gateway (e2e)', () => {
  let app: INestApplication;
  let auth: Awaited<ReturnType<typeof startFakeAuth>>;
  let valid: string;

  beforeAll(async () => {
    auth = await startFakeAuth();
    valid = await signToken(keys.privateKey, { sub: '42' });
    // Un mismo servidor falso hace de auth y de billing.
    app = await createApp({
      AUTH_SERVICE_URL: auth.url,
      BILLING_SERVICE_URL: auth.url,
      AUTH_JWT_PUBLIC_KEY: keys.publicPem,
      RATE_LIMIT_MAX: '1000',
      RATE_LIMIT_AUTH_MAX: '1000',
      MAX_BODY_BYTES: '1000',
    });
  });

  afterAll(async () => {
    await app.close();
    await auth.close();
  });

  const http = () => request(app.getHttpServer());

  describe('proxy', () => {
    it('reescribe /auth/login a /api/auth/login y reenvia el body intacto', async () => {
      const body = { email: 'a@b.com', password: 'x' };
      const res = await http().post('/auth/login').send(body).expect(200);

      const upstream = auth.requests.at(-1)!;
      expect(upstream.method).toBe('POST');
      expect(upstream.url).toBe('/api/auth/login');
      expect(JSON.parse(res.body.echo)).toEqual(body);
    });

    it('conserva el query string', async () => {
      await http().post('/auth/login?x=1').send({}).expect(404);
      expect(auth.requests.at(-1)!.url).toBe('/api/auth/login?x=1');
    });

    it('responde 404 para servicios no registrados', async () => {
      await http().get('/users/1').expect(404);
    });
  });

  describe('gestion de roles (solo admin)', () => {
    it('un usuario sin rol admin recibe 403 en /auth/roles y /auth/users', async () => {
      const user = await signToken(keys.privateKey, { sub: '100' });
      auth.roles['100'] = ['user'];
      await http().get('/auth/roles').set('Authorization', `Bearer ${user}`).expect(403);
      await http().put('/auth/users/5/roles').set('Authorization', `Bearer ${user}`).send({ roles: [] }).expect(403);
    });

    it('un admin pasa (con cualquiera de sus roles) y se propagan los roles', async () => {
      const admin = await signToken(keys.privateKey, { sub: '101' });
      auth.roles['101'] = ['editor', 'admin'];
      await http().get('/auth/roles').set('Authorization', `Bearer ${admin}`).expect(200);
      expect(auth.requests.at(-1)!.headers['x-user-roles']).toBe('editor,admin');
    });

    it('sin token recibe 401', async () => {
      await http().get('/auth/roles').expect(401);
    });
  });

  describe('billing', () => {
    it('reenvia /billing/customers a /api/customers con el Bearer intacto', async () => {
      await http().get('/billing/customers').set('Authorization', `Bearer ${valid}`).expect(200);
      const upstream = auth.requests.at(-1)!;
      expect(upstream.url).toBe('/api/customers');
      expect(upstream.headers.authorization).toBe(`Bearer ${valid}`);
    });

    it('billing exige Bearer', async () => {
      await http().get('/billing/customers').expect(401);
    });
  });

  describe('validacion del JWT (clave publica)', () => {
    const me = (token: string) => http().get('/auth/me').set('Authorization', `Bearer ${token}`);

    it('deja pasar las rutas publicas sin token', async () => {
      await http().post('/auth/login').send({}).expect(200);
    });

    it('rechaza rutas protegidas sin token (401) sin llamar al servicio', async () => {
      const before = auth.requests.length;
      const res = await http().get('/auth/me').expect(401);
      expect(res.body).toMatchObject({ success: false, message: 'Token no proporcionado.' });
      expect(auth.requests.length).toBe(before);
    });

    it('acepta un JWT valido y propaga el id de usuario (sub)', async () => {
      await me(valid).expect(200);
      expect(auth.requests.at(-1)!.headers['x-user-id']).toBe('42');
    });

    it('valida localmente: no llama a auth para validar el token', async () => {
      const calls = auth.meCalls();
      await http().get('/billing/customers').set('Authorization', `Bearer ${valid}`).expect(200);
      await http().get('/billing/customers').set('Authorization', `Bearer ${valid}`).expect(200);
      expect(auth.meCalls()).toBe(calls);
    });

    it('acepta un token recien emitido aunque su nbf tenga decimales (Passport)', async () => {
      // Passport emite iat/nbf con microsegundos; el token se usa en el mismo segundo.
      const fresh = await signToken(keys.privateKey, { notBefore: Date.now() / 1000 + 0.5 });
      await me(fresh).expect(200);
    });

    it('rechaza un token cuyo nbf esta lejos en el futuro', async () => {
      await me(await signToken(keys.privateKey, { notBefore: Date.now() / 1000 + 3600 })).expect(401);
    });

    it('rechaza un token expirado', async () => {
      const expired = await signToken(keys.privateKey, { expiresIn: '-1m' });
      await me(expired).expect(401);
    });

    it('rechaza un token firmado con otra clave', async () => {
      await me(await signToken(otherKeys.privateKey)).expect(401);
    });

    it('rechaza un token manipulado (payload cambiado)', async () => {
      const [h, , sig] = valid.split('.');
      const forged = Buffer.from(JSON.stringify({ sub: '1', exp: 9999999999 })).toString('base64url');
      await me(`${h}.${forged}.${sig}`).expect(401);
    });

    it('rechaza alg "none" y tokens basura', async () => {
      const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"1"}').toString('base64url')}.`;
      await me(none).expect(401);
      await me('abc').expect(401);
    });

    it('ignora X-User-Id enviado por el cliente (anti-suplantacion)', async () => {
      await http().post('/auth/login').set('X-User-Id', '999').send({}).expect(200);
      expect(auth.requests.at(-1)!.headers['x-user-id']).toBeUndefined();
      await me(valid).set('X-User-Id', '999').expect(200);
      expect(auth.requests.at(-1)!.headers['x-user-id']).toBe('42');
    });
  });

  describe('cabeceras y limites', () => {
    it('devuelve X-Request-Id y respeta el que envia el cliente', async () => {
      const res = await http().get('/health/live').set('X-Request-Id', 'abc-123').expect(200);
      expect(res.headers['x-request-id']).toBe('abc-123');
      const generated = await http().get('/health/live');
      expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('aplica cabeceras de helmet', async () => {
      const res = await http().get('/health/live');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('no habilita CORS por defecto', async () => {
      const res = await http().get('/health/live').set('Origin', 'http://evil.com');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('rechaza bodies mayores al limite con 413', async () => {
      await http().post('/auth/login').send({ pad: 'x'.repeat(2000) }).expect(413);
    });
  });

  describe('health', () => {
    it('/health/live responde ok', async () => {
      await http().get('/health/live').expect(200);
    });

    it('/health reporta auth y billing como up', async () => {
      const res = await http().get('/health').expect(200);
      expect(res.body.services).toEqual([
        expect.objectContaining({ name: 'auth', status: 'up' }),
        expect.objectContaining({ name: 'billing', status: 'up' }),
      ]);
    });
  });
});

describe('Gateway con servicio caido (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Puerto sin nadie escuchando.
    app = await createApp({
      AUTH_JWT_PUBLIC_KEY: keys.publicPem,
      AUTH_SERVICE_URL: 'http://127.0.0.1:9',
      RATE_LIMIT_MAX: '1000',
      RATE_LIMIT_AUTH_MAX: '1000',
    });
  });
  afterAll(() => app.close());

  it('el proxy responde 502 en JSON', async () => {
    const res = await request(app.getHttpServer()).post('/auth/login').send({}).expect(502);
    expect(res.body).toMatchObject({ success: false });
  });

  it('una ruta protegida con JWT valido responde 502 (la validacion no depende de auth)', async () => {
    const token = await signToken(keys.privateKey);
    await request(app.getHttpServer()).get('/auth/me').set('Authorization', `Bearer ${token}`).expect(502);
  });

  it('/health responde 503 degraded', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(503);
    expect(res.body.status).toBe('degraded');
  });
});

describe('Rate limiting (e2e)', () => {
  let app: INestApplication;
  let auth: Awaited<ReturnType<typeof startFakeAuth>>;

  beforeAll(async () => {
    auth = await startFakeAuth();
    app = await createApp({
      AUTH_JWT_PUBLIC_KEY: keys.publicPem,
      AUTH_SERVICE_URL: auth.url,
      RATE_LIMIT_MAX: '1000',
      RATE_LIMIT_AUTH_MAX: '3',
    });
  });
  afterAll(async () => {
    await app.close();
    await auth.close();
  });

  it('limita /auth/login tras N intentos (429)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await request(app.getHttpServer()).post('/auth/login').send({})).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });
});
