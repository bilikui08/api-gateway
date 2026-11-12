import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SignJWT } from 'jose';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/setup-app.js';

/** Par de claves RSA de prueba: hace de "auth" firmando JWT que el gateway verifica. */
export function makeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicKey,
    privateKey,
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

export async function signToken(
  privateKey: KeyObject,
  opts: { sub?: string; expiresIn?: string; aud?: string; alg?: string; notBefore?: number } = {},
) {
  const jwt = new SignJWT({ scopes: [] })
    .setProtectedHeader({ alg: opts.alg ?? 'RS256' })
    .setSubject(opts.sub ?? '42')
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '15m');
  if (opts.aud) jwt.setAudience(opts.aud);
  if (opts.notBefore !== undefined) jwt.setNotBefore(opts.notBefore);
  return jwt.sign(privateKey);
}

export interface Recorded {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Microservicio de auth falso: registra lo recibido y responde como Laravel. */
export async function startFakeAuth() {
  const requests: Recorded[] = [];
  let meCalls = 0;
  const roles: Record<string, string[]> = {};
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.url === '/api/auth/me') {
        // Solo cuenta consultas del gateway (las proxiadas llevan X-User-Id).
        if (!req.headers['x-user-id']) meCalls++;
        const sub = JSON.parse(
          Buffer.from(String(req.headers.authorization).split('.')[1] ?? 'e30', 'base64url').toString(),
        ).sub as string;
        return json(200, { success: true, data: { id: Number(sub), email: 'a@b.com', roles: roles[sub] ?? ['user'] } });
      }
      if (req.url === '/api/auth/roles') return json(200, { success: true, data: [] });
      if (req.url === '/api/auth/login') return json(200, { success: true, echo: body });
      if (req.url === '/api/auth/logout') return json(200, { success: true });
      if (req.url === '/') return json(200, {});
      if (req.url === '/api/customers') return json(200, { success: true, data: [] });
      json(404, { success: false });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    meCalls: () => meCalls,
    roles,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export async function createApp(env: Record<string, string>): Promise<INestApplication> {
  Object.assign(process.env, env);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ bodyParser: false });
  setupApp(app);
  await app.init();
  return app;
}
