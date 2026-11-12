import { validateEnv } from './env.validation.js';

describe('validateEnv', () => {
  it('acepta una configuracion minima valida', () => {
    expect(() => validateEnv({ AUTH_SERVICE_URL: 'http://auth:8083' })).not.toThrow();
  });

  it('falla si falta AUTH_SERVICE_URL', () => {
    expect(() => validateEnv({})).toThrow(/AUTH_SERVICE_URL es obligatoria/);
  });

  it('falla si AUTH_SERVICE_URL no es una URL', () => {
    expect(() => validateEnv({ AUTH_SERVICE_URL: 'no-url' })).toThrow(/URL valida/);
  });

  it('falla con numeros invalidos y los lista todos', () => {
    expect(() =>
      validateEnv({ AUTH_SERVICE_URL: 'http://a', PORT: 'abc', RATE_LIMIT_MAX: '-1' }),
    ).toThrow(/PORT[\s\S]*RATE_LIMIT_MAX/);
  });
});
