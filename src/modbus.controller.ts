import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { LoggerService } from './logger.service';
import { ModbusService } from './modbus.service';
import { StorageService } from './storage.service';

function parseEpochInput(raw: string | undefined, fallbackEpoch: number): number {
  if (!raw || raw.trim() === '') {
    return fallbackEpoch;
  }

  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) {
    return Math.floor(asNumber);
  }

  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) {
    return Math.floor(parsed / 1000);
  }

  throw new HttpException(`Fecha/hora invalida: ${raw}`, HttpStatus.BAD_REQUEST);
}

@Controller('api')
export class ModbusController {
  constructor(
    private readonly modbus: ModbusService,
    private readonly logger: LoggerService,
    private readonly storage: StorageService,
  ) {}

  @Get('lecturas')
  async lecturas() {
    try {
      return await this.modbus.readAll();
    } catch (error) {
      throw new HttpException(
        `No se pudo leer del PLC: ${(error as Error).message}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  @Post('perimetros/:id')
  async perimetros(@Param('id') id: string, @Body('value') value: unknown) {
    try {
      const response = await this.modbus.writePerimetro(id, value);
      await this.storage.markEvent('WRITE_PERIMETRO', JSON.stringify(response));
      return response;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `No se pudo escribir perimetro: ${(error as Error).message}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  @Post('pulsos/:id')
  async pulsos(@Param('id') id: string, @Body('value') value: unknown) {
    try {
      const response = await this.modbus.writePulsos(id, value);
      await this.storage.markEvent('WRITE_PULSOS', JSON.stringify(response));
      return response;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `No se pudo escribir pulsos: ${(error as Error).message}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  @Post('pulsos/reset-all-start')
  async resetAllPulsosAndStart() {
    try {
      const response = await this.modbus.resetAllPulsos();
      await this.storage.markEvent('RESET_ALL_PULSOS_START', JSON.stringify(response));
      await this.logger.captureNow();
      return {
        ...response,
        message: 'Pulsos reseteados. Registro continuo iniciado desde este punto.',
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `No se pudo resetear pulsos: ${(error as Error).message}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  @Post('reset/:memory')
  async reset(@Param('memory') memory: string) {
    try {
      const response = await this.modbus.resetMemory(memory);
      await this.storage.markEvent('RESET_MEMORY', JSON.stringify(response));
      return response;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `No se pudo resetear memoria: ${(error as Error).message}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  @Get('history')
  async history(@Query('from') from?: string, @Query('to') to?: string) {
    const now = Math.floor(Date.now() / 1000);
    const fromEpoch = parseEpochInput(from, now - 12 * 3600);
    const toEpoch = parseEpochInput(to, now);

    if (fromEpoch > toEpoch) {
      throw new HttpException('from no puede ser mayor que to.', HttpStatus.BAD_REQUEST);
    }

    const readings = await this.storage.getReadings(fromEpoch, toEpoch);
    const events = await this.storage.getEvents(fromEpoch, toEpoch);

    return {
      fromEpoch,
      toEpoch,
      totalReadings: readings.length,
      totalEvents: events.length,
      events,
      readings,
    };
  }

  @Get('analysis')
  async analysis(@Query('from') from?: string, @Query('to') to?: string) {
    const now = Math.floor(Date.now() / 1000);
    const fromEpoch = parseEpochInput(from, now - 12 * 3600);
    const toEpoch = parseEpochInput(to, now);

    if (fromEpoch > toEpoch) {
      throw new HttpException('from no puede ser mayor que to.', HttpStatus.BAD_REQUEST);
    }

    return this.storage.analyzeInterval(fromEpoch, toEpoch);
  }
}
