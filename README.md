# API Gateway

Gateway en Node.js (NestJS) que actúa como proxy inverso delante de los microservicios.
Los clientes hablan solo con el gateway (`:3000`); este valida el token Bearer y reenvía
cada petición al servicio correspondiente.

```
Cliente ──► API Gateway :3000 ──► auth-api (Laravel, :8083)
              │  valida Bearer     ──► (otros microservicios)
              └─ rate limit, helmet, CORS, request-id, logs JSON
```

## Qué hace

- **Proxy por servicio**: `/<prefijo>/...` → `<servicio>/<prefijo interno>/...` (p. ej. `/auth/login` → `/api/auth/login`).
- **Autenticación**: valida el JWT (RS256) que emite auth (Passport) **localmente con su clave pública**: firma, expiración y `aud` opcional. No llama a auth en cada petición. El `sub` del token es el id de usuario.
- **Los servicios validan el mismo JWT por su cuenta** con la misma clave pública: el gateway reenvía el `Authorization` intacto y no hay secreto compartido. Un cliente que llegue directo a un servicio sin un token válido no consigue nada.
- **Autorización por rol**: reglas por ruta (403 si el rol no coincide). El token no lleva el rol, así que solo en las rutas con `roleRules` se consulta `GET /api/auth/me` (con caché).
- **`X-User-Id`**: el gateway lo añade solo como dato informativo (logs). Descarta el que envíe el cliente; los servicios no deben fiarse de él.
- **Seguridad**: helmet, CORS cerrado por defecto, rate limiting (más estricto en login/register/forgot-password), límite de body.
- **Observabilidad**: `X-Request-Id` en cada petición y un log JSON por petición.
- **Resiliencia básica**: errores JSON uniformes (502 servicio caído, 504 timeout, 503 auth no disponible), shutdown ordenado.
- **Health**: `GET /health/live` (el proceso responde) y `GET /health` (además comprueba cada servicio; 503 si alguno cae).

## Puesta en marcha

### Docker (recomendado)

```bash
cp .env.example .env        # ajusta los valores
docker compose up -d --build
curl http://localhost:3000/health
```

El contenedor llega al servicio de auth en el host mediante `DOCKER_AUTH_SERVICE_URL`
(por defecto `http://host.docker.internal:8083`). Si auth corre en otra red de Docker,
usa el nombre del servicio, p. ej. `http://auth-service:80`.

### Local

```bash
npm install
npm run start:dev           # usa AUTH_SERVICE_URL de .env
```

## Variables de entorno

| Variable | Por defecto | Descripción |
|---|---|---|
| `AUTH_SERVICE_URL` | — (obligatoria) | URL base del servicio de auth |
| `AUTH_JWT_PUBLIC_KEY` | — (obligatoria, o `AUTH_JWT_PUBLIC_KEY_PATH`) | Clave **pública** de auth (`storage/oauth-public.key`), PEM en una línea con `\n` |
| `AUTH_JWT_AUDIENCE` | vacío | Si se define, el claim `aud` (id del cliente OAuth) debe coincidir |
| `AUTH_VALIDATE_PATH` | `/api/auth/me` | Endpoint con el usuario y su rol (solo en rutas con `roleRules`) |
| `TOKEN_CACHE_TTL_MS` | `30000` | Caché de esa consulta de usuario/rol |
| `BILLING_SERVICE_URL` | vacío | Si se define, se registra `/billing/*` |
| `PORT` | `3000` | Puerto del gateway |
| `CORS_ORIGINS` | vacío (CORS cerrado) | Orígenes permitidos, separados por coma |
| `TRUST_PROXY` | vacío | Nº de proxies delante (nginx, balanceador) para ver la IP real |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Ventana del rate limit |
| `RATE_LIMIT_MAX` | `120` | Peticiones por ventana e IP |
| `RATE_LIMIT_AUTH_MAX` | `10` | Ídem para login, register y forgot-password |
| `MAX_BODY_BYTES` | `1048576` | Tamaño máximo de body (por `Content-Length`) |

El gateway no arranca si la configuración es inválida (ver [src/config/env.validation.ts](src/config/env.validation.ts)).

## Rutas

| Ruta pública | Destino | Acceso |
|---|---|---|
| `POST /auth/login`, `/auth/register`, `/auth/forgot-password`, `/auth/refresh` | `/api/auth/...` | Público |
| Cualquier otra `/auth/*` (p. ej. `GET /auth/me`, `POST /auth/logout`) | `/api/auth/...` | Bearer |
| `/billing/*` (p. ej. `GET /billing/customers`) | `<BILLING_SERVICE_URL>/api/*` | Bearer |
| `GET /health`, `GET /health/live` | gateway | Público |

Ejemplo:

```bash
TOKEN=$(curl -s -X POST localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"tu@mail.com","password":"..."}' | jq -r '.data.tokens.access_token')

curl localhost:3000/auth/me -H "Authorization: Bearer $TOKEN"
```

## Añadir un microservicio

1. Agrega su URL a `.env` y `.env.example` (p. ej. `USERS_SERVICE_URL`).
2. Añade una entrada en [src/gateway/services.config.ts](src/gateway/services.config.ts):

   ```ts
   {
     prefix: 'users',                          // público: /users/...
     target: required(env, 'USERS_SERVICE_URL'),
     upstreamPrefix: '/api/users',             // interno: /api/users/...
     publicRoutes: [],                         // rutas sin Bearer
     roleRules: [{ path: 'admin', roles: ['admin'] }],  // /users/admin/** solo admin
   }
   ```

3. Si el servicio tiene un `/health` propio, el gateway ya lo incluye en `GET /health`.

`roleRules` acepta `methods` opcional (`['DELETE']`) y varios roles (basta con uno).
El rol sale de `data.role` (texto) o `data.roles` (lista) de la respuesta de `/me`.

## Despliegue en Hostinger (Business Web Hosting)

Se despliega como **Node.js Web App** desde el repositorio de GitHub (hPanel → Websites → Add Website → Node.js web app):

- Node.js 24 (o 22), build command `npm run build`, entry file `dist/main.js`.
- Variables de entorno en el panel: `AUTH_SERVICE_URL`, `AUTH_JWT_PUBLIC_KEY`, `BILLING_SERVICE_URL`, `CORS_ORIGINS`, `TRUST_PROXY`.
- Hostinger detiene la app tras un tiempo sin tráfico y la reinicia en la siguiente petición: la caché de tokens y el rate limit (en memoria) se pierden entonces.
- Verifica en el primer despliegue que la app escucha en el puerto que asigna la plataforma (`PORT`).
- En hosting compartido no hay red interna: no importa, porque cada servicio valida el JWT con la clave pública y no confía en quién le llama.

## Tests y calidad

```bash
npm test           # unitarios
npm run test:e2e   # e2e: levanta el gateway real contra un servicio de auth falso
npm run lint
npx tsc --noEmit
```

## Limitaciones conocidas

- La caché de tokens y el rate limit viven en memoria: con **varias instancias** del gateway cada una tiene los suyos. Para escalar horizontalmente, muévelos a Redis.
- **Revocación**: validar la firma no consulta la BD de auth, así que un token revocado (logout) sigue valiendo hasta que caduque. Por eso los access tokens de auth son cortos (15 min, `PASSPORT_ACCESS_TOKEN_TTL_MINUTES`) y se renuevan con el refresh token.
- **Rotación de claves**: si cambias el par de claves de auth, hay que actualizar `AUTH_JWT_PUBLIC_KEY` en el gateway y en cada servicio (todos los tokens vigentes dejan de valer). Un JWKS lo automatizaría.
- El límite de body se basa en `Content-Length`; una petición `chunked` sin esa cabecera lo esquiva.
- Sin circuit breaker ni reintentos: un servicio lento ocupa conexiones hasta el timeout (15 s).
