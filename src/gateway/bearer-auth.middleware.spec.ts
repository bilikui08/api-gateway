import type { NextFunction, Request, Response } from 'express';
import { createBearerAuth } from './bearer-auth.middleware.js';
import type { ServiceConfig } from './services.config.js';

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

function mockMe(user: Record<string, unknown> | number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      typeof user === 'number'
        ? new Response('{}', { status: user })
        : new Response(JSON.stringify({ data: user }), { status: 200 }),
    ),
  );
}

async function run(method: string, url: string, token = 'tok') {
  const guard = createBearerAuth(service, { validateUrl: 'http://auth/me', cacheTtlMs: 1000 });
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

afterEach(() => vi.unstubAllGlobals());

describe('guard: autorizacion por rol', () => {
  it('permite a un admin entrar a /admin', async () => {
    mockMe({ id: 1, role: 'admin' });
    const r = await run('GET', '/users/admin/panel');
    expect(r.next).toHaveBeenCalled();
    expect(r.req.headers['x-user-roles']).toBe('admin');
  });

  it('responde 403 a un usuario sin el rol', async () => {
    mockMe({ id: 2, role: 'user' });
    const r = await run('GET', '/users/admin');
    expect(r.status).toBe(403);
    expect(r.next).not.toHaveBeenCalled();
  });

  it('no confunde prefijos parecidos (/administrators no es /admin)', async () => {
    mockMe({ id: 2, role: 'user' });
    const r = await run('GET', '/users/administrators');
    expect(r.next).toHaveBeenCalled();
  });

  it('respeta el filtro por metodo', async () => {
    mockMe({ id: 2, role: 'user' });
    expect((await run('GET', '/users/reports')).next).toHaveBeenCalled();
    expect((await run('DELETE', '/users/reports')).status).toBe(403);
  });

  it('acepta cualquiera de los roles permitidos y el formato roles[]', async () => {
    mockMe({ id: 3, roles: ['auditor'] });
    expect((await run('DELETE', '/users/reports/7')).next).toHaveBeenCalled();
  });

  it('sin rol en /me se trata como sin permisos', async () => {
    mockMe({ id: 4 });
    expect((await run('GET', '/users/admin')).status).toBe(403);
  });

  it('las rutas publicas no piden token', async () => {
    const r = await run('GET', '/users/public', '');
    expect(r.next).toHaveBeenCalled();
  });

  it('401 si el servicio de auth rechaza el token', async () => {
    mockMe(401);
    expect((await run('GET', '/users/x')).status).toBe(401);
  });
});
