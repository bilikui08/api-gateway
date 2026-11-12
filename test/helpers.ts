import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/setup-app.js';

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
        // Las validaciones del guard no llevan X-User-Id; las peticiones proxiadas si.
        if (!req.headers['x-user-id']) meCalls++;
        return req.headers.authorization === 'Bearer valid'
          ? json(200, { success: true, data: { id: 42, email: 'a@b.com', role: 'user' } })
          : json(401, { success: false, message: 'No autenticado.' });
      }
      if (req.url === '/api/auth/login') return json(200, { success: true, echo: body });
      if (req.url === '/api/auth/logout') return json(200, { success: true });
      if (req.url === '/') return json(200, {});
      json(404, { success: false });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    meCalls: () => meCalls,
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
