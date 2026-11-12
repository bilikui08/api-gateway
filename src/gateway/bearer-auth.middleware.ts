import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { ServiceConfig } from './services.config.js';

interface CachedUser {
  user: Record<string, unknown>;
  expires: number;
}

export interface BearerAuthOptions {
  /** URL completa del endpoint de Laravel que valida el token (GET, 200 = valido). */
  validateUrl: string;
  cacheTtlMs: number;
}

/**
 * Valida el Bearer contra el servicio de auth (token opaco de Passport) con
 * cache en memoria, y propaga la identidad en cabeceras X-User-*.
 * Si algun dia hay varias instancias del gateway, esta cache se movera a Redis.
 */
export function createBearerAuth(service: ServiceConfig, options: BearerAuthOptions) {
  const cache = new Map<string, CachedUser>();

  const restOf = (req: Request) =>
    req.originalUrl.split('?')[0].replace(/\/+$/, '').split('/').slice(2).join('/');

  const isPublic = (req: Request) => {
    const rest = restOf(req);
    return service.publicRoutes.some(
      (r) => r.method === req.method && r.path === rest,
    );
  };

  const requiredRoles = (req: Request): string[] | undefined => {
    const rest = restOf(req);
    return service.roleRules?.find(
      (r) =>
        (rest === r.path || rest.startsWith(`${r.path}/`)) &&
        (!r.methods || r.methods.includes(req.method)),
    )?.roles;
  };

  const fail = (res: Response, status: number, message: string) =>
    res.status(status).json({ success: false, message, data: null, errors: null });

  return async (req: Request, res: Response, next: NextFunction) => {
    // Nunca confiar en cabeceras de identidad enviadas por el cliente.
    delete req.headers['x-user-id'];
    delete req.headers['x-user-email'];
    delete req.headers['x-user-roles'];

    if (isPublic(req)) return next();

    const authorization = req.headers.authorization;
    const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
    if (!authorization || !match) return fail(res, 401, 'Token no proporcionado.');

    const key = createHash('sha256').update(match[1]).digest('hex');
    const now = Date.now();

    // Tras un logout el token deja de ser valido: se saca de la cache.
    if (req.method === 'POST' && req.originalUrl.split('?')[0].endsWith('/logout')) {
      cache.delete(key);
    }

    let entry = cache.get(key);
    if (entry && entry.expires <= now) {
      cache.delete(key);
      entry = undefined;
    }

    if (!entry) {
      try {
        const upstream = await fetch(options.validateUrl, {
          headers: { authorization, accept: 'application/json' },
          signal: AbortSignal.timeout(5000),
        });
        if (upstream.status === 401 || upstream.status === 403) {
          return fail(res, 401, 'Token invalido o expirado.');
        }
        if (!upstream.ok) return fail(res, 503, 'Servicio de autenticacion no disponible.');

        const body = (await upstream.json()) as { data?: Record<string, unknown> };
        entry = { user: body.data ?? (body as Record<string, unknown>), expires: now + options.cacheTtlMs };
        for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
        cache.set(key, entry);
      } catch {
        return fail(res, 503, 'Servicio de autenticacion no disponible.');
      }
    }

    const { id } = entry.user;
    if (typeof id === 'string' || typeof id === 'number') req.headers['x-user-id'] = String(id);
    const roles = userRoles(entry.user);
    const needed = requiredRoles(req);
    if (needed && !needed.some((r) => roles.includes(r))) {
      return fail(res, 403, 'No tienes permisos para acceder a este recurso.');
    }
    if (roles.length) req.headers['x-user-roles'] = roles.join(',');
    if (typeof entry.user.email === 'string') req.headers['x-user-email'] = entry.user.email;
    next();
  };
}

/** Acepta `role: "admin"` o `roles: ["admin", "editor"]` en la respuesta de /me. */
function userRoles(user: Record<string, unknown>): string[] {
  const raw = user.roles ?? user.role;
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return list.filter((r): r is string => typeof r === 'string' && r !== '');
}
