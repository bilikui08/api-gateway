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
- **Autenticación**: valida el token Bearer (Passport, token opaco) llamando a `GET /api/auth/me` del servicio de auth, con caché en memoria (30 s). Un `logout` invalida la caché.
- **Autorización por rol**: reglas por ruta (403 si el rol no coincide).
- **Identidad hacia los servicios**: añade `X-User-Id`, `X-User-Email` y `X-User-Roles`. Descarta los que envíe el cliente.
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
| `AUTH_VALIDATE_PATH` | `/api/auth/me` | Endpoint que valida el Bearer (GET, 200 = válido) |
| `TOKEN_CACHE_TTL_MS` | `30000` | Caché de validaciones exitosas |
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

## Tests y calidad

```bash
npm test           # unitarios
npm run test:e2e   # e2e: levanta el gateway real contra un servicio de auth falso
npm run lint
npx tsc --noEmit
```

## Limitaciones conocidas

- La caché de tokens y el rate limit viven en memoria: con **varias instancias** del gateway cada una tiene los suyos. Para escalar horizontalmente, muévelos a Redis.
- Un token revocado puede seguir aceptándose hasta `TOKEN_CACHE_TTL_MS` (salvo con `logout` a través del gateway, que invalida la caché).
- El límite de body se basa en `Content-Length`; una petición `chunked` sin esa cabecera lo esquiva.
- Sin circuit breaker ni reintentos: un servicio lento ocupa conexiones hasta el timeout (15 s).
