import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { HTTP_PORT } from './config';
import { ModbusService } from './modbus.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });

  app.enableShutdownHooks();

  const modbus = app.get(ModbusService);
  const stop = async () => {
    await modbus.close();
    await app.close();
  };

  process.on('SIGINT', async () => {
    await stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await stop();
    process.exit(0);
  });

  await app.listen(HTTP_PORT);
  console.log(`NestJS Modbus server arriba en http://localhost:${HTTP_PORT}`);
}

bootstrap().catch((error) => {
  console.error('Error fatal al iniciar servidor:', error);
  process.exit(1);
});
