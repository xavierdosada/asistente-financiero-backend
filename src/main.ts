import './load-env';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const rawCorsOrigins = process.env.CORS_ORIGINS?.trim();
  const corsOrigin =
    rawCorsOrigins && rawCorsOrigins.length > 0
      ? rawCorsOrigins
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean)
      : process.env.NODE_ENV === 'production'
        ? true
        : ['http://localhost:5173'];

  app.enableCors({ origin: corsOrigin });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

bootstrap();
