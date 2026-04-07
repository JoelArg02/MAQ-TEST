import { Module } from '@nestjs/common';
import { LoggerService } from './logger.service';
import { ModbusController } from './modbus.controller';
import { ModbusService } from './modbus.service';
import { StorageService } from './storage.service';
import { WebController } from './web.controller';

@Module({
  controllers: [ModbusController, WebController],
  providers: [ModbusService, StorageService, LoggerService],
})
export class AppModule {}
