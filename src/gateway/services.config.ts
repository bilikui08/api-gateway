export interface PublicRoute {
  method: string;
  /** Path relativo al prefijo del servicio, p. ej. "login". */
  path: string;
}

export interface RoleRule {
  /** Path relativo al prefijo del servicio. Cubre ese path y todo lo que cuelga de el. */
  path: string;
  /** Solo estos metodos; si se omite, todos. */
  methods?: string[];
  /** El usuario debe tener al menos uno de estos roles. */
  roles: string[];
}

export interface ServiceConfig {
  /** Prefijo publico en el gateway: /<prefix>/... */
  prefix: string;
  /** URL base del microservicio. */
  target: string;
  /** Prefijo que el microservicio espera: /<prefix>/x -> <upstreamPrefix>/x */
  upstreamPrefix: string;
  /** Rutas que no exigen Bearer. */
  publicRoutes: PublicRoute[];
  /** Autorizacion por rol. Las rutas sin regla solo exigen un token valido. */
  roleRules?: RoleRule[];
}

/**
 * Registro de microservicios. Para agregar uno nuevo basta con sumar una
 * entrada (y su URL en .env); no hay que tocar nada mas.
 */
export function loadServices(env: NodeJS.ProcessEnv = process.env): ServiceConfig[] {
  const services: ServiceConfig[] = [
    {
      prefix: 'auth',
      target: required(env, 'AUTH_SERVICE_URL'),
      upstreamPrefix: '/api/auth',
      publicRoutes: [
        { method: 'POST', path: 'login' },
        { method: 'POST', path: 'register' },
        { method: 'POST', path: 'forgot-password' },
        { method: 'POST', path: 'refresh' },
      ],
    },
  ];

  // Billing: se registra solo si esta configurada su URL.
  // /billing/customers -> <BILLING_SERVICE_URL>/api/customers
  if (env.BILLING_SERVICE_URL) {
    services.push({
      prefix: 'billing',
      target: required(env, 'BILLING_SERVICE_URL'),
      upstreamPrefix: '/api',
      publicRoutes: [],
    });
  }

  // Para otro servicio, con una zona solo para admin:
  // { prefix: 'users', target: required(env, 'USERS_SERVICE_URL'),
  //   upstreamPrefix: '/api/users', publicRoutes: [],
  //   roleRules: [{ path: 'admin', roles: ['admin'] }] },
  return services;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Falta la variable de entorno ${key}`);
  return value.replace(/\/+$/, '');
}
