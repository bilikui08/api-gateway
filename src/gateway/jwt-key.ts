import { createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Clave publica con la que auth (Passport) firma los JWT (RS256).
 * Se toma de AUTH_JWT_PUBLIC_KEY (PEM; admite "\\n" literales para ponerla en una
 * sola linea) o, si no, del archivo AUTH_JWT_PUBLIC_KEY_PATH.
 */
export function loadPublicKey(env: NodeJS.ProcessEnv = process.env): KeyObject {
  const inline = env.AUTH_JWT_PUBLIC_KEY;
  const path = env.AUTH_JWT_PUBLIC_KEY_PATH;
  const pem = inline ? inline.replace(/\\n/g, '\n') : path ? readFileSync(path, 'utf8') : undefined;

  if (!pem) {
    throw new Error('Falta AUTH_JWT_PUBLIC_KEY o AUTH_JWT_PUBLIC_KEY_PATH');
  }
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('debe ser una clave RSA');
    return key;
  } catch (error) {
    throw new Error(`AUTH_JWT_PUBLIC_KEY invalida: ${(error as Error).message}`);
  }
}
