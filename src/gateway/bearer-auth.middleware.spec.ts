import { generateKeyPairSync } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { SignJWT } from 'jose';
import { createBearerAuth } from './bearer-auth.middleware.js';
import type { ServiceConfig } from './services.config.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const service: ServiceConfig = {
  prefix: 'users',
  target: 'http://users',
  upstreamPrefix: '/api/users',
  publicRoutes: [{ method: 'GET', path: 'public' }],
  roleRules: [
    { path: 'admin', roles: ['admin'] },
    { path: 'reports', methods: ['DELETE'], roles: ['admin', 'auditor'] },
  ],
};

const sign = (sub = '1', opts: { aud?: string } = {}) => {
  const jwt = new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setSubject(sub).setExpirationTime('15m');
  if (opts.aud) jwt.setAudience(opts.aud);
  return jwt.sign(privateKey);
};

const fetchMock = vi.fn();
function mockMe(user: Record<string, unknown> | number) {
  fetchMock.mockImplementation(async () =>
    typeof user === 'number'
      ? new Response('{}', { status: user })
      : new Response(JSON.stringify({ data: user }), { status: 200 }),
  );
}

async function run(method: string, url: string, token?: string, audience?: string) {
  const guard = createBearerAuth(service, {
    publicKey,
    audience,
    userInfoUrl: 'http://auth/me',
    cacheTtlMs: 1000,
  });
  const req = {
    method,
    originalUrl: url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as unknown as Request;
  let status = 200;
  const res = {
    status(s: number) {
      status = s;
      return this;
    },
    json: vi.fn(),
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  await guard(req, res, next);
  return { status, req, next: next as unknown as ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('guard: JWT local', () => {
  it('rutas sin regla de rol: valida solo la firma, sin llamar a auth', async () => {
    const r = await run('GET', '/users/profile', await sign('7'));
    expect(r.next).toHaveBeenCalled();
    expect(r.req.headers['x-user-id']).toBe('7');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('las rutas publicas no piden token', async () => {
    expect((await run('GET', '/users/public')).next).toHaveBeenCalled();
  });

  it('401 sin token y con token invalido', async () => {
    expect((await run('GET', '/users/x')).status).toBe(401);
    expect((await run('GET', '/users/x', 'basura')).status).toBe(401);
  });

  it('exige el audience si esta configurado', async () => {
    expect((await run('GET', '/users/x', await sign('1', { aud: 'cliente-a' }), 'cliente-a')).next).toHaveBeenCalled();
    expect((await run('GET', '/users/x', await sign('1', { aud: 'otro' }), 'cliente-a')).status).toBe(401);
  });
});

describe('guard: autorizacion por rol (consulta el rol a auth)', () => {
  it('permite a un admin entrar a /admin', async () => {
    mockMe({ id: 1, email: 'a@b.com', role: 'admin' });
    const r = await run('GET', '/users/admin/panel', await sign());
    expect(r.next).toHaveBeenCalled();
    expect(r.req.headers['x-user-roles']).toBe('admin');
  });

  it('responde 403 a un usuario sin el rol', async () => {
    mockMe({ id: 2, role: 'user' });
    const r = await run('GET', '/users/admin', await sign());
    expect(r.status).toBe(403);
    expect(r.next).not.toHaveBeenCalled();
  });

  it('no confunde prefijos parecidos (/administrators no es /admin)', async () => {
    const r = await run('GET', '/users/administrators', await sign());
    expect(r.next).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('respeta el filtro por metodo', async () => {
    mockMe({ id: 2, role: 'user' });
    expect((await run('GET', '/users/reports', await sign())).next).toHaveBeenCalled();
    expect((await run('DELETE', '/users/reports', await sign())).status).toBe(403);
  });

  it('acepta cualquiera de los roles permitidos y el formato roles[]', async () => {
    mockMe({ id: 3, roles: ['auditor'] });
    expect((await run('DELETE', '/users/reports/7', await sign())).next).toHaveBeenCalled();
  });

  it('sin rol en la respuesta se trata como sin permisos', async () => {
    mockMe({ id: 4 });
    expect((await run('GET', '/users/admin', await sign())).status).toBe(403);
  });

  it('401 si auth rechaza el token al consultar el rol; 503 si no responde', async () => {
    mockMe(401);
    expect((await run('GET', '/users/admin', await sign())).status).toBe(401);
    mockMe(500);
    expect((await run('GET', '/users/admin', await sign())).status).toBe(503);
  });
});
