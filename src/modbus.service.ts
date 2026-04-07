import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import ModbusRTU from 'modbus-serial';
import { IP_PLC, PLC_PORT, PLC_SLAVE_ID, PLC_TIMEOUT_MS } from './config';
import { LECTURAS, M_MAP, PERIMETROS, PULSOS, ValueType } from './modbus-map';

export type SnapshotValue = {
  address: number;
  name: string;
  type: ValueType;
  value: number | string;
};

@Injectable()
export class ModbusService {
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

      const values: SnapshotValue[] = [];

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
        epochSeconds: Math.floor(Date.now() / 1000),
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

  async resetAllPulsos() {
    return this.runQueued(async () => {
      await this.ensureConnected();

      for (const target of Object.values(PULSOS)) {
        const payload = this.encodeUInt32WordSwap(0);
        await this.client.writeRegisters(target.address, payload);
      }

      return {
        ok: true,
        message: 'Pulsos 1000-1060 reseteados a 0.',
        resetAddresses: Object.values(PULSOS).map((x) => x.address),
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
