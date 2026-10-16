import {
  Injectable,
  NestMiddleware,
} from '@nestjs/common';

import type {
  Request,
  Response,
  NextFunction,
} from 'express';

import { createProxyMiddleware } from 'http-proxy-middleware';

@Injectable()
export class AuthProxyMiddleware implements NestMiddleware {
  private readonly proxy = createProxyMiddleware<Request, Response>({
    target: process.env.AUTH_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: {
      '^/auth/login$': '/api/auth/login',
      '^/auth/logout$': '/api/auth/logout',
      '^/auth/refresh$': '/api/auth/refresh',
    },
    proxyTimeout: 15000,
    timeout: 15000,
  });

  use(req: Request, res: Response, next: NextFunction) {
    this.proxy(req, res, next);
  }
}