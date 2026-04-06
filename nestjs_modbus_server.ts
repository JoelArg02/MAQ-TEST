import 'reflect-metadata';
import { Body, Controller, Get, HttpException, HttpStatus, Module, Param, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import ModbusRTU from 'modbus-serial';

type ValueType = 'int32' | 'float32';

type ReadItem = {
  address: number;
  name: string;
  type: ValueType;
};

type PulsosTarget = {
  address: number;
  name: string;
};

type PerimetroTarget = {
  address: number;
  name: string;
};

const IP_PLC = process.env.PLC_IP ?? '192.168.100.64';
const PLC_PORT = Number(process.env.PLC_PORT ?? 502);
const PLC_SLAVE_ID = Number(process.env.PLC_SLAVE_ID ?? 1);
const PLC_TIMEOUT_MS = Number(process.env.PLC_TIMEOUT_MS ?? 3000);

const LECTURAS: ReadItem[] = [
  { address: 1000, name: 'Pulsos Telar 1', type: 'int32' },
  { address: 1010, name: 'Pulsos Telar 2', type: 'int32' },
  { address: 1020, name: 'Pulsos Telar 3', type: 'int32' },
  { address: 1030, name: 'Pulsos Cortadora 1', type: 'int32' },
  { address: 1040, name: 'Pulsos Cortadora 2', type: 'int32' },
  { address: 1050, name: 'Pulsos Cortadora 3', type: 'int32' },
  { address: 1060, name: 'Pulsos Cortadora 4', type: 'int32' },
  { address: 1070, name: 'Perimetro Rodillo 1', type: 'float32' },
  { address: 1080, name: 'Perimetro Rodillo 2', type: 'float32' },
  { address: 1090, name: 'Perimetro Rodillo 3', type: 'float32' },
  { address: 1100, name: 'Metros Tejidos T1', type: 'float32' },
  { address: 1110, name: 'Metros Tejidos T2', type: 'float32' },
  { address: 1120, name: 'Metros Tejidos T3', type: 'float32' },
  { address: 1130, name: 'Sacos Cortadora 1', type: 'int32' },
  { address: 1140, name: 'Sacos Cortadora 2', type: 'int32' },
  { address: 1150, name: 'Sacos Cortadora 3', type: 'int32' },
  { address: 1160, name: 'Sacos Cortadora 4', type: 'int32' },
];

const PULSOS: Record<string, PulsosTarget> = {
  '1': { address: 1000, name: 'Pulsos Telar 1' },
  '2': { address: 1010, name: 'Pulsos Telar 2' },
  '3': { address: 1020, name: 'Pulsos Telar 3' },
  '4': { address: 1030, name: 'Pulsos Cortadora 1' },
  '5': { address: 1040, name: 'Pulsos Cortadora 2' },
  '6': { address: 1050, name: 'Pulsos Cortadora 3' },
  '7': { address: 1060, name: 'Pulsos Cortadora 4' },
};

const PERIMETROS: Record<string, PerimetroTarget> = {
  '1': { address: 1070, name: 'Rodillo 1' },
  '2': { address: 1080, name: 'Rodillo 2' },
  '3': { address: 1090, name: 'Rodillo 3' },
};

const M_MAP: Record<string, number> = {
  m0: 0,
  m1: 1,
  m2: 2,
  m3: 3,
  m4: 4,
  m5: 5,
  m6: 6,
};

class ModbusService {
  private readonly client = new ModbusRTU();
  private queue: Promise<unknown> = Promise.resolve();

  private async runQueued<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async ensureConnected(): Promise<void> {
    if (!this.client.isOpen) {
      await this.client.connectTCP(IP_PLC, { port: PLC_PORT });
      this.client.setID(PLC_SLAVE_ID);
      this.client.setTimeout(PLC_TIMEOUT_MS);
    }
  }

  private encodeUInt32WordSwap(value: number): [number, number] {
    const highWord = (value >>> 16) & 0xffff;
    const lowWord = value & 0xffff;
    return [lowWord, highWord];
  }

  private decodeUInt32WordSwap(registers: number[]): number {
    const lowWord = registers[0] & 0xffff;
    const highWord = registers[1] & 0xffff;
    return (((highWord << 16) >>> 0) | lowWord) >>> 0;
  }

  private encodeFloat32WordSwap(value: number): [number, number] {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeFloatBE(value, 0);
    const highWord = buffer.readUInt16BE(0);
    const lowWord = buffer.readUInt16BE(2);
    return [lowWord, highWord];
  }

  private decodeFloat32WordSwap(registers: number[]): number {
    const lowWord = registers[0] & 0xffff;
    const highWord = registers[1] & 0xffff;
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeUInt16BE(highWord, 0);
    buffer.writeUInt16BE(lowWord, 2);
    return Number(buffer.readFloatBE(0).toFixed(2));
  }

  async readAll() {
    return this.runQueued(async () => {
      await this.ensureConnected();

      const values: Array<{ address: number; name: string; type: ValueType; value: number | string }> = [];

      for (const item of LECTURAS) {
        try {
          const response = await this.client.readHoldingRegisters(item.address, 2);
          const regs = response.data;
          const value =
            item.type === 'float32'
              ? this.decodeFloat32WordSwap(regs)
              : this.decodeUInt32WordSwap(regs);

          values.push({
            address: item.address,
            name: item.name,
            type: item.type,
            value,
          });
        } catch {
          values.push({
            address: item.address,
            name: item.name,
            type: item.type,
            value: 'ERROR_COM',
          });
        }
      }

      return {
        plc: {
          ip: IP_PLC,
          port: PLC_PORT,
          slaveId: PLC_SLAVE_ID,
        },
        timestamp: new Date().toISOString(),
        values,
      };
    });
  }

  async writePerimetro(id: string, rawValue: unknown) {
    const target = PERIMETROS[id];
    if (!target) {
      throw new HttpException('ID de perimetro no valido. Use 1, 2 o 3.', HttpStatus.BAD_REQUEST);
    }

    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      throw new HttpException('El valor debe ser numerico.', HttpStatus.BAD_REQUEST);
    }

    const rounded = Number(value.toFixed(2));

    return this.runQueued(async () => {
      await this.ensureConnected();
      const payload = this.encodeFloat32WordSwap(rounded);
      await this.client.writeRegisters(target.address, payload);

      return {
        ok: true,
        id,
        name: target.name,
        address: target.address,
        value: rounded,
      };
    });
  }

  async writePulsos(id: string, rawValue: unknown) {
    const target = PULSOS[id];
    if (!target) {
      throw new HttpException('ID de maquina no valido. Use 1..7.', HttpStatus.BAD_REQUEST);
    }

    const value = Number(rawValue);
    if (!Number.isInteger(value) || value < 0) {
      throw new HttpException('Pulsos debe ser un entero >= 0.', HttpStatus.BAD_REQUEST);
    }

    return this.runQueued(async () => {
      await this.ensureConnected();
      const payload = this.encodeUInt32WordSwap(value >>> 0);
      await this.client.writeRegisters(target.address, payload);

      return {
        ok: true,
        id,
        name: target.name,
        address: target.address,
        value,
      };
    });
  }

  async resetMemory(cmd: string) {
    const key = cmd.toLowerCase();
    const coil = M_MAP[key];

    if (coil === undefined) {
      throw new HttpException('Memoria invalida. Use m0..m6.', HttpStatus.BAD_REQUEST);
    }

    return this.runQueued(async () => {
      await this.ensureConnected();
      await this.client.writeCoil(coil, true);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await this.client.writeCoil(coil, false);

      return {
        ok: true,
        memory: key,
        coil,
        pulseMs: 1000,
      };
    });
  }

  async close(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.close();
    }
  }
}

@Controller('api')
class ModbusController {
  constructor(private readonly modbus: ModbusService) {}

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
      return await this.modbus.writePerimetro(id, value);
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
      return await this.modbus.writePulsos(id, value);
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

  @Post('reset/:memory')
  async reset(@Param('memory') memory: string) {
    try {
      return await this.modbus.resetMemory(memory);
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
}

@Module({
  controllers: [ModbusController],
  providers: [ModbusService],
})
class AppModule {}

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

  await app.listen(Number(process.env.PORT ?? 3000));
  console.log(`NestJS Modbus server arriba en http://localhost:${process.env.PORT ?? 3000}`);
}

bootstrap().catch((error) => {
  console.error('Error fatal al iniciar servidor:', error);
  process.exit(1);
});
