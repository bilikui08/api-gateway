import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp, startFakeAuth } from './helpers.js';

describe('Gateway (e2e)', () => {
  let app: INestApplication;
  let auth: Awaited<ReturnType<typeof startFakeAuth>>;

  beforeAll(async () => {
    auth = await startFakeAuth();
    app = await createApp({
      AUTH_SERVICE_URL: auth.url,
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

  describe('guard de Bearer', () => {
    it('deja pasar las rutas publicas sin token', async () => {
      await http().post('/auth/login').send({}).expect(200);
    });

    it('rechaza rutas protegidas sin token (401) sin llamar al servicio', async () => {
      const before = auth.requests.length;
      const res = await http().get('/auth/me').expect(401);
      expect(res.body).toMatchObject({ success: false, message: 'Token no proporcionado.' });
      expect(auth.requests.length).toBe(before);
    });

    it('rechaza un token invalido (401)', async () => {
      await http().get('/auth/me').set('Authorization', 'Bearer nope').expect(401);
    });

    it('acepta un token valido y propaga la identidad', async () => {
      await http().get('/auth/me').set('Authorization', 'Bearer valid').expect(200);
      const upstream = auth.requests.at(-1)!;
      expect(upstream.headers['x-user-id']).toBe('42');
      expect(upstream.headers['x-user-email']).toBe('a@b.com');
      expect(upstream.headers['x-user-roles']).toBe('user');
      expect(upstream.headers.authorization).toBe('Bearer valid');
    });

    it('ignora X-User-Id enviado por el cliente (anti-suplantacion)', async () => {
      await http().post('/auth/login').set('X-User-Id', '999').send({}).expect(200);
      expect(auth.requests.at(-1)!.headers['x-user-id']).toBeUndefined();
    });

    it('cachea las validaciones y un logout invalida la cache', async () => {
      await http().get('/auth/me').set('Authorization', 'Bearer valid').expect(200);
      const calls = auth.meCalls();
      await http().get('/auth/me').set('Authorization', 'Bearer valid').expect(200);
      expect(auth.meCalls()).toBe(calls); // segunda vez: desde cache

      await http().post('/auth/logout').set('Authorization', 'Bearer valid').expect(200);
      await http().get('/auth/me').set('Authorization', 'Bearer valid').expect(200);
      expect(auth.meCalls()).toBeGreaterThan(calls); // revalidado tras logout
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

    it('/health reporta el servicio de auth como up', async () => {
      const res = await http().get('/health').expect(200);
      expect(res.body.services).toEqual([expect.objectContaining({ name: 'auth', status: 'up' })]);
    });
  });
});

describe('Gateway con servicio caido (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Puerto sin nadie escuchando.
    app = await createApp({
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

  it('una ruta protegida responde 503 si no se puede validar el token', async () => {
    await request(app.getHttpServer()).get('/auth/me').set('Authorization', 'Bearer x').expect(503);
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
