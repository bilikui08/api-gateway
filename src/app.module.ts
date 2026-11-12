import { MiddlewareConsumer, Module, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation.js';
import { createBearerAuth } from './gateway/bearer-auth.middleware.js';
import { createServiceProxy } from './gateway/proxy.factory.js';
import { requestIdMiddleware } from './gateway/request-id.middleware.js';
import { loadPublicKey } from './gateway/jwt-key.js';
import { loadServices } from './gateway/services.config.js';
import { HealthModule } from './health/health.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnv,
    }),
    HealthModule,
  ],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(requestIdMiddleware).forRoutes('*path');

    const services = loadServices();
    const authService = services.find((s) => s.prefix === 'auth');
    const publicKey = loadPublicKey();
    for (const service of services) {
      const bearer = createBearerAuth(service, {
        publicKey,
        audience: process.env.AUTH_JWT_AUDIENCE || undefined,
        userInfoUrl: `${authService?.target}${process.env.AUTH_VALIDATE_PATH ?? '/api/auth/me'}`,
        cacheTtlMs: Number(process.env.TOKEN_CACHE_TTL_MS ?? 30000),
      });
      consumer
        .apply(bearer, createServiceProxy(service))
        .forRoutes({ path: `${service.prefix}/*path`, method: RequestMethod.ALL });
    }
  }
}
