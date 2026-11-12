/** Validacion del entorno al arrancar: falla rapido si algo esta mal. */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const errors: string[] = [];
  const str = (k: string) => (typeof config[k] === 'string' ? (config[k] as string) : undefined);

  const auth = str('AUTH_SERVICE_URL');
  if (!auth) errors.push('AUTH_SERVICE_URL es obligatoria');
  else if (!URL.canParse(auth)) errors.push('AUTH_SERVICE_URL no es una URL valida');

  for (const key of [
    'PORT',
    'TOKEN_CACHE_TTL_MS',
    'RATE_LIMIT_MAX',
    'RATE_LIMIT_AUTH_MAX',
    'RATE_LIMIT_WINDOW_MS',
    'MAX_BODY_BYTES',
  ]) {
    const v = str(key);
    if (v !== undefined && !(Number.isInteger(Number(v)) && Number(v) > 0)) {
      errors.push(`${key} debe ser un entero positivo`);
    }
  }

  if (errors.length) {
    throw new Error(`Configuracion invalida:\n - ${errors.join('\n - ')}`);
  }
  return config;
}
