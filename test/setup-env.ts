import { generateKeyPairSync } from 'node:crypto';

// ConfigModule valida el entorno al importar AppModule, antes de que cada test fije el suyo.
// Valores por defecto validos; cada suite los sobrescribe en createApp().
process.env.AUTH_SERVICE_URL ??= 'http://127.0.0.1:9';
process.env.AUTH_JWT_PUBLIC_KEY ??= generateKeyPairSync('rsa', { modulusLength: 2048 })
  .publicKey.export({ type: 'spki', format: 'pem' })
  .toString();
