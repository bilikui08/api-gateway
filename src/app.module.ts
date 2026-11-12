import { MiddlewareConsumer, Module, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation.js';
import { createBearerAuth } from './gateway/bearer-auth.middleware.js';
import { createServiceProxy } from './gateway/proxy.factory.js';
import { requestIdMiddleware } from './gateway/request-id.middleware.js';
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

    const authService = loadServices().find((s) => s.prefix === 'auth');
    for (const service of loadServices()) {
      const bearer = createBearerAuth(service, {
        validateUrl: `${authService?.target}${process.env.AUTH_VALIDATE_PATH ?? '/api/auth/me'}`,
        cacheTtlMs: Number(process.env.TOKEN_CACHE_TTL_MS ?? 30000),
      });
      consumer
        .apply(bearer, createServiceProxy(service))
        .forRoutes({ path: `${service.prefix}/*path`, method: RequestMethod.ALL });
    }
  }
}
