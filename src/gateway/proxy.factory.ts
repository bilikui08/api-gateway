import type { Request, Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import type { ServiceConfig } from './services.config.js';

export function createServiceProxy(service: ServiceConfig) {
  const publicPrefix = `/${service.prefix}`;

  return createProxyMiddleware<Request, Response>({
    target: service.target,
    changeOrigin: true,
    // /auth/login -> /api/auth/login
    pathRewrite: (_path, req) =>
      service.upstreamPrefix + req.originalUrl.slice(publicPrefix.length),
    proxyTimeout: 15000,
    timeout: 15000,
    on: {
      error: (err, _req, res) => {
        const code = (err as NodeJS.ErrnoException).code;
        const timeout = code === 'ECONNRESET' || code === 'ETIMEDOUT';
        const status = timeout ? 504 : 502;
        if ('writeHead' in res && !res.headersSent) {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              success: false,
              message: timeout
                ? `El servicio '${service.prefix}' no respondio a tiempo.`
                : `El servicio '${service.prefix}' no esta disponible.`,
              data: null,
              errors: null,
            }),
          );
        }
      },
    },
  });
}
