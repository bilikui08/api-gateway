import { generateKeyPairSync } from 'node:crypto';
import { validateEnv } from './env.validation.js';

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .publicKey.export({ type: 'spki', format: 'pem' })
  .toString();
const base = { AUTH_SERVICE_URL: 'http://auth:8083', AUTH_JWT_PUBLIC_KEY: pem };

describe('validateEnv', () => {
  it('acepta una configuracion minima valida', () => {
    expect(() => validateEnv(base)).not.toThrow();
  });

  it('acepta la clave publica en una sola linea con \\n literales', () => {
    expect(() => validateEnv({ ...base, AUTH_JWT_PUBLIC_KEY: pem.replace(/\n/g, '\\n') })).not.toThrow();
  });

  it('falla si falta AUTH_SERVICE_URL', () => {
    expect(() => validateEnv({ AUTH_JWT_PUBLIC_KEY: pem })).toThrow(/AUTH_SERVICE_URL es obligatoria/);
  });

  it('falla si AUTH_SERVICE_URL no es una URL', () => {
    expect(() => validateEnv({ ...base, AUTH_SERVICE_URL: 'no-url' })).toThrow(/URL valida/);
  });

  it('falla si falta la clave publica o es invalida', () => {
    expect(() => validateEnv({ AUTH_SERVICE_URL: 'http://a' })).toThrow(/AUTH_JWT_PUBLIC_KEY/);
    expect(() => validateEnv({ ...base, AUTH_JWT_PUBLIC_KEY: 'no es una clave' })).toThrow(/invalida/);
  });

  it('falla con numeros invalidos y los lista todos', () => {
    expect(() => validateEnv({ ...base, PORT: 'abc', RATE_LIMIT_MAX: '-1' })).toThrow(/PORT[\s\S]*RATE_LIMIT_MAX/);
  });

  it('valida la URL de billing si se define', () => {
    expect(() => validateEnv({ ...base, BILLING_SERVICE_URL: 'x' })).toThrow(/BILLING_SERVICE_URL/);
  });
});
