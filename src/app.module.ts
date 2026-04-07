import { Module } from '@nestjs/common';
import { LoggerService } from './logger.service';
import { ModbusController } from './modbus.controller';
import { ModbusService } from './modbus.service';
import { StorageService } from './storage.service';
import { SyncService } from './sync.service';
import { WebController } from './web.controller';

@Module({
  controllers: [ModbusController, WebController],
  providers: [ModbusService, StorageService, LoggerService, SyncService],
})
export class AppModule {}
