import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http/http-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const configService = app.get(ConfigService);

  const apiPrefix = configService.getOrThrow<string>('API_PREFIX');
  const port = configService.getOrThrow<number>('PORT');
  // Comma-separated allowlist (e.g. the customer web app + admin dashboard
  // origins) - never '*', which is incompatible with credentials: true.
  const corsOrigins = configService
    .getOrThrow<string>('CORS_ORIGIN')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: corsOrigins, credentials: true });
  app.setGlobalPrefix(apiPrefix);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('IrieFishmongers API')
    .setDescription('Backend API for the IrieFishmongers seafood marketplace')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup(`${apiPrefix}/docs`, app, swaggerDocument);

  // Explicitly bind all interfaces so the API is reachable through container
  // and Codespaces port forwarding, not only from the container's loopback.
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
