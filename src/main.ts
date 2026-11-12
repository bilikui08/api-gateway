import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { setupApp } from './setup-app.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // El gateway solo hace proxy: el body debe llegar intacto al servicio destino.
    bodyParser: false,
  });

  setupApp(app);

  const port = Number(process.env.PORT ?? 3000);

  await app.listen(port, '0.0.0.0');

  console.log(`API Gateway running on http://localhost:${port}`);
}

void bootstrap();
