import { createHash, type KeyObject } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { jwtVerify } from 'jose';
import type { ServiceConfig } from './services.config.js';

interface CachedUser {
  user: Record<string, unknown>;
  expires: number;
}

export interface BearerAuthOptions {
  /** Clave publica de auth con la que se verifica la firma (RS256) de los JWT. */
  publicKey: KeyObject;
  /** Si se define, el claim `aud` del token debe coincidir (en Passport: id del cliente OAuth). */
  audience?: string;
  /** Endpoint de auth que devuelve el usuario (con su rol). Solo se usa en rutas con roleRules. */
  userInfoUrl: string;
  cacheTtlMs: number;
}

/**
 * Valida el JWT (firma, expiracion) localmente con la clave publica de auth, sin
 * llamar a ningun servicio. El `sub` del token es el id de usuario.
 *
 * Solo en las rutas con `roleRules` consulta (con cache) el endpoint de usuario para
 * conocer el rol, porque el token no lo incluye.
 *
 * Limitacion: un token revocado (logout) sigue siendo valido hasta que caduque; por eso
 * los access tokens de auth son de vida corta.
 */
export function createBearerAuth(service: ServiceConfig, options: BearerAuthOptions) {
  const userCache = new Map<string, CachedUser>();

  const restOf = (req: Request) =>
    req.originalUrl.split('?')[0].replace(/\/+$/, '').split('/').slice(2).join('/');

  const isPublic = (req: Request) => {
    const rest = restOf(req);
    return service.publicRoutes.some((r) => r.method === req.method && r.path === rest);
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

  /** Usuario completo (email, rol) desde auth, con cache en memoria por token. */
  async function fetchUser(authorization: string, token: string): Promise<Record<string, unknown>> {
    const key = createHash('sha256').update(token).digest('hex');
    const now = Date.now();
    const hit = userCache.get(key);
    if (hit && hit.expires > now) return hit.user;

    const upstream = await fetch(options.userInfoUrl, {
      headers: { authorization, accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (upstream.status === 401 || upstream.status === 403) throw new RevokedError();
    if (!upstream.ok) throw new Error(`auth respondio ${upstream.status}`);

    const body = (await upstream.json()) as { data?: Record<string, unknown> };
    const user = body.data ?? (body as Record<string, unknown>);
    for (const [k, v] of userCache) if (v.expires <= now) userCache.delete(k);
    userCache.set(key, { user, expires: now + options.cacheTtlMs });
    return user;
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    // Nunca confiar en cabeceras de identidad enviadas por el cliente.
    delete req.headers['x-user-id'];
    delete req.headers['x-user-email'];
    delete req.headers['x-user-roles'];

    if (isPublic(req)) return next();

    const authorization = req.headers.authorization;
    const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
    if (!authorization || !match) return fail(res, 401, 'Token no proporcionado.');
    const token = match[1];

    let sub: string;
    try {
      const { payload } = await jwtVerify(token, options.publicKey, {
        algorithms: ['RS256'],
        // Passport emite iat/nbf con decimales y jose compara contra segundos enteros: sin
        // tolerancia, un token usado en el mismo segundo en que se emitio se rechaza.
        clockTolerance: 5,
        ...(options.audience && { audience: options.audience }),
      });
      if (typeof payload.sub !== 'string' || payload.sub === '') throw new Error('sin sub');
      sub = payload.sub;
    } catch {
      return fail(res, 401, 'Token invalido o expirado.');
    }

    // Informativo (logs); los servicios validan el JWT por su cuenta y no deben fiarse de esto.
    req.headers['x-user-id'] = sub;

    const needed = requiredRoles(req);
    if (needed) {
      let user: Record<string, unknown>;
      try {
        user = await fetchUser(authorization, token);
      } catch (error) {
        if (error instanceof RevokedError) return fail(res, 401, 'Token invalido o expirado.');
        return fail(res, 503, 'Servicio de autenticacion no disponible.');
      }
      const roles = userRoles(user);
      if (!needed.some((r) => roles.includes(r))) {
        return fail(res, 403, 'No tienes permisos para acceder a este recurso.');
      }
      if (roles.length) req.headers['x-user-roles'] = roles.join(',');
      if (typeof user.email === 'string') req.headers['x-user-email'] = user.email;
    }
    next();
  };
}

class RevokedError extends Error {}

/** Acepta `role: "admin"` o `roles: ["admin", "editor"]` en la respuesta de /me. */
function userRoles(user: Record<string, unknown>): string[] {
  const raw = user.roles ?? user.role;
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return list.filter((r): r is string => typeof r === 'string' && r !== '');
}
