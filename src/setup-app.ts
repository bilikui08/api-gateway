import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';

const num = (key: string, fallback: number) => Number(process.env[key] ?? fallback);

const tooMany = {
  success: false,
  message: 'Demasiadas peticiones. Intenta nuevamente mas tarde.',
  data: null,
  errors: null,
};

/** Seguridad y protecciones transversales del gateway. */
export function setupApp(app: INestApplication) {
  const http = app.getHttpAdapter().getInstance();

  // Detras de nginx/balanceador: 1 (un proxy), o lo que indique TRUST_PROXY.
  // Sin esto, el rate limit veria siempre la IP del proxy.
  const trust = process.env.TRUST_PROXY;
  if (trust) http.set('trust proxy', /^\d+$/.test(trust) ? Number(trust) : trust);

  app.use(helmet());

  const origins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins.length ? origins : false,
    credentials: true,
    exposedHeaders: ['x-request-id'],
  });

  // Rechaza bodies enormes sin leerlos (el gateway hace streaming, no parsea).
  const maxBody = num('MAX_BODY_BYTES', 1_048_576);
  app.use((req: Request, res: Response, next: NextFunction) => {
    const length = Number(req.headers['content-length'] ?? 0);
    if (length > maxBody) {
      return res.status(413).json({
        success: false,
        message: 'El cuerpo de la peticion es demasiado grande.',
        data: null,
        errors: null,
      });
    }
    next();
  });

  const windowMs = num('RATE_LIMIT_WINDOW_MS', 60_000);
  const common = { windowMs, standardHeaders: true, legacyHeaders: false, message: tooMany };

  // Estricto en endpoints sensibles (fuerza bruta). Va antes del general.
  app.use(
    ['/auth/login', '/auth/forgot-password', '/auth/register'],
    rateLimit({ ...common, limit: num('RATE_LIMIT_AUTH_MAX', 10) }),
  );
  app.use(rateLimit({ ...common, limit: num('RATE_LIMIT_MAX', 120), skip: (req) => req.path === '/health/live' }));

  app.enableShutdownHooks();
}
