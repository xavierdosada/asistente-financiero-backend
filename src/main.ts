import './load-env';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const rawCorsOrigins = process.env.CORS_ORIGINS?.trim();
  const configuredOrigins = (rawCorsOrigins ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map(normalizeConfiguredOrigin)
    .filter((origin): origin is string => Boolean(origin));

  const fallbackOrigins =
    process.env.NODE_ENV === 'production'
      ? ['https://asistente-financiero-frontend.vercel.app', '*.vercel.app']
      : ['http://localhost:5173'];

  const allowedOrigins = configuredOrigins.length > 0 ? configuredOrigins : fallbackOrigins;
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (isOriginAllowed(origin, allowedOrigins)) return callback(null, true);
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

bootstrap();

function normalizeConfiguredOrigin(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith('*.')) return value.toLowerCase();
  try {
    const url = new URL(value);
    return url.origin.toLowerCase();
  } catch {
    const fixed = value.replace(/\/+$/, '');
    if (fixed.startsWith('*.')) return fixed.toLowerCase();
    try {
      const url = new URL(fixed);
      return url.origin.toLowerCase();
    } catch {
      return null;
    }
  }
}

function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  const normalized = origin.toLowerCase().replace(/\/+$/, '');
  for (const candidate of allowedOrigins) {
    if (candidate.startsWith('*.')) {
      const suffix = candidate.slice(1);
      if (normalized.endsWith(suffix)) return true;
      continue;
    }
    if (normalized === candidate) return true;
  }
  return false;
}
