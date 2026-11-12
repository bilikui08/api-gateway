import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { loadServices } from '../gateway/services.config.js';

@Controller('health')
export class HealthController {
  /** Liveness: solo indica que el proceso del gateway responde. */
  @Get('live')
  live() {
    return { success: true, service: 'api-gateway', status: 'ok' };
  }

  /** Readiness: ademas comprueba que cada servicio aguas abajo responde. */
  @Get()
  async check(@Res({ passthrough: true }) res: Response) {
    const services = await Promise.all(
      loadServices().map(async (s) => {
        const start = Date.now();
        try {
          // Cualquier respuesta HTTP < 500 significa que el servicio esta vivo.
          const r = await fetch(s.target, { signal: AbortSignal.timeout(3000) });
          const up = r.status < 500;
          return { name: s.prefix, status: up ? 'up' : 'down', latencyMs: Date.now() - start };
        } catch {
          return { name: s.prefix, status: 'down', latencyMs: Date.now() - start };
        }
      }),
    );

    const healthy = services.every((s) => s.status === 'up');
    if (!healthy) res.status(HttpStatus.SERVICE_UNAVAILABLE);

    return {
      success: healthy,
      service: 'api-gateway',
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      services,
    };
  }
}
