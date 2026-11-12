import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Asigna/propaga X-Request-Id y emite una linea JSON de acceso por peticion
 * (apta para Loki/ELK/CloudWatch). El usuario se lee al terminar, cuando el
 * guard de Bearer ya pudo propagar X-User-Id.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && incoming ? incoming : randomUUID();
  req.headers['x-request-id'] = id;
  res.setHeader('x-request-id', id);

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const status = res.statusCode;
    const entry = {
      time: new Date().toISOString(),
      level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
      msg: 'request',
      requestId: id,
      method: req.method,
      // Sin query string: puede contener tokens u otros datos sensibles.
      path: req.originalUrl.split('?')[0],
      status,
      durationMs: Number((process.hrtime.bigint() - start) / 1_000_000n),
      userId: req.headers['x-user-id'] ?? null,
      ip: req.ip,
    };
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  });
  next();
}
