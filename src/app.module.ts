import {
  Module,
  MiddlewareConsumer,
  RequestMethod,
} from '@nestjs/common';

import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { HealthModule } from './health/health.module.js';
import { AuthProxyMiddleware } from './proxy/auth-proxy.middleware.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    HealthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(AuthProxyMiddleware)
      .forRoutes({
        path: 'auth/login',
        method: RequestMethod.POST,
      });
  }
}