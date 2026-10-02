import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  // the snapshot value is true in development and false in production/test
  const snapshot = process.env.NODE_ENV === 'development';
  Logger.log('NODE_ENV value: ', process.env.NODE_ENV || 'development');
  const app = await NestFactory.create(AppModule, {
    snapshot,
  });
  app.setGlobalPrefix('v1', {
    exclude: ['docs', 'docs-json', 'docs/*path'],
  });
  // Orígenes extra (p. ej. el túnel del frontend que sirve /autorizar/:id).
  const extraOrigins = [
    process.env.SUPPLIER_AUTH_URL,
    ...(process.env.CORS_EXTRA_ORIGINS ?? '').split(','),
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => {
      try {
        return [new URL(value).origin];
      } catch {
        Logger.warn(`Origen CORS inválido ignorado: ${value}`);
        return [];
      }
    });
  app.enableCors({
    origin: [
      ...extraOrigins,
      'http://localhost:3000',
      'http://localhost:3001',
      'https://optus.bamp.lat',
      'http://192.168.0.16:3001',
      'http://192.168.0.16:3000',
      'https://api.rnd.honeyguide.optus.lat',
      'https://rnd.optus.lat',
      'https://api.honeyguide.optus.lat',
      'https://www.optus.lat',
    ],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidUnknownValues: true,
      transform: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('optus API')
    .setDescription(
      'API para autenticación, pagos y webhooks. Usa Bearer token para rutas protegidas.',
    )
    .setVersion('1.0')
    .addServer('/', 'Servidor actual')
    .addServer('http://localhost:3001', 'local')
    .addServer('http://localhost:3000', 'Local')
    .addServer('https://api.rnd.honeyguide.optus.lat', 'Development')
    .addServer('https://rnd.optus.lat', 'Development')
    .addServer('https://api.honeyguide.optus.lat', 'Production')
    .addServer('https://www.optus.lat', 'Production')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description: 'Token emitido por /auth/login',
    })
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
    customSiteTitle: 'optus API Docs',
  });

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
