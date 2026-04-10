import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import ModbusRTU from 'modbus-serial';
import {
  IP_PLC,
  MODBUS_CONNECT_HOST,
  MODBUS_CONNECT_PORT,
  PLC_PORT,
  PLC_SLAVE_ID,
  PLC_TIMEOUT_MS,
  USE_MODBUS_PROXY,
} from './config';
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
  /** Buffer reutilizable para encode/decode float32 — evita alloc por cada lectura */
  private readonly fBuf = Buffer.allocUnsafe(4);

  /**
   * Pool de objetos SnapshotValue preallocados — uno por cada LECTURA.
   * Se mutan en lugar de crear objetos nuevos cada segundo.
   * Esto elimina ~17 objetos × 1/s = 1,020 objetos/min del GC.
   */
  private readonly valuePool: SnapshotValue[] = LECTURAS.map((item) => ({
    address: item.address,
    name: item.name,
    type: item.type,
    value: 0,
  }));

  /** Objeto de respuesta del PLC — preallocado, se muta */
  private readonly plcInfo = Object.freeze({
    ip: IP_PLC,
    port: PLC_PORT,
    slaveId: PLC_SLAVE_ID,
    viaProxy: USE_MODBUS_PROXY,
    routeHost: MODBUS_CONNECT_HOST,
    routePort: MODBUS_CONNECT_PORT,
  });
  private readonly snapshotResult = {
    plc: this.plcInfo,
    timestamp: '',
    epochSeconds: 0,
    values: this.valuePool,
  };

  private readonly readBlocks = [
    { from: 1000, to: 1061 },
    { from: 1100, to: 1121 },
  ] as const;

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
      await this.client.connectTCP(MODBUS_CONNECT_HOST, { port: MODBUS_CONNECT_PORT });
      this.client.setID(PLC_SLAVE_ID);
      this.client.setTimeout(PLC_TIMEOUT_MS);
    }
  }

  private async resetConnection(): Promise<void> {
    if (this.client.isOpen) {
      try {
        await this.client.close();
      } catch {
        // Ignorar errores al cerrar para permitir reconexion limpia.
      }
    }
  }

  private async withReconnect<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureConnected();
    try {
      return await fn();
    } catch {
      await this.resetConnection();
      await this.ensureConnected();
      return await fn();
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
    this.fBuf.writeFloatBE(value, 0);
    return [this.fBuf.readUInt16BE(2), this.fBuf.readUInt16BE(0)];
  }

  private decodeFloat32WordSwap(registers: number[]): number {
    this.fBuf.writeUInt16BE(registers[1] & 0xffff, 0);
    this.fBuf.writeUInt16BE(registers[0] & 0xffff, 2);
    return Math.round(this.fBuf.readFloatBE(0) * 100) / 100;
  }

  private decodeByType(type: ValueType, regs: number[]): number {
    return type === 'float32'
      ? this.decodeFloat32WordSwap(regs)
      : this.decodeUInt32WordSwap(regs);
  }

  private getItemsInRange(from: number, to: number): Array<{ index: number; address: number; type: ValueType }> {
    const items: Array<{ index: number; address: number; type: ValueType }> = [];
    for (let i = 0; i < LECTURAS.length; i++) {
      const it = LECTURAS[i];
      if (it.address >= from && it.address + 1 <= to) {
        items.push({ index: i, address: it.address, type: it.type });
      }
    }
    return items;
  }

  async readAll() {
    return this.runQueued(async () => {
      for (const block of this.readBlocks) {
        const items = this.getItemsInRange(block.from, block.to);
        try {
          const count = block.to - block.from + 1;
          const response = await this.withReconnect(() => this.client.readHoldingRegisters(block.from, count));
          const data = response.data;

          for (let j = 0; j < items.length; j++) {
            const item = items[j];
            const offset = item.address - block.from;
            const regs = [data[offset], data[offset + 1]];
            this.valuePool[item.index].value = this.decodeByType(item.type, regs);
          }
        } catch {
          for (let j = 0; j < items.length; j++) {
            this.valuePool[items[j].index].value = 'ERROR_COM';
          }
        }
      }

      const now = Date.now();
      this.snapshotResult.timestamp = new Date(now).toISOString();
      this.snapshotResult.epochSeconds = (now / 1000) | 0;
      return this.snapshotResult;
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
      const payload = this.encodeFloat32WordSwap(rounded);
      await this.withReconnect(() => this.client.writeRegisters(target.address, payload));

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
      const payload = this.encodeUInt32WordSwap(value >>> 0);
      await this.withReconnect(() => this.client.writeRegisters(target.address, payload));

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
      const targets = Object.values(PULSOS).sort((a, b) => a.address - b.address);
      const firstAddress = targets[0].address;
      const lastAddress = targets[targets.length - 1].address + 1;
      const totalRegisters = lastAddress - firstAddress + 1;

      // Un solo paquete FC16 para resetear todo el bloque en el mismo ciclo de escritura.
      const payload = new Array<number>(totalRegisters).fill(0);
      await this.withReconnect(() => this.client.writeRegisters(firstAddress, payload));

      return {
        ok: true,
        message: `Pulsos D${firstAddress}-D${lastAddress} reseteados a 0 en bloque.`,
        resetAddresses: targets.map((x) => x.address),
        blockStartAddress: firstAddress,
        blockEndAddress: lastAddress,
        totalRegisters,
      };
    });
  }

  async resetAllForFullReset() {
    return this.runQueued(async () => {
      const blocks = [
        { from: 1000, to: 1061 },
        { from: 1100, to: 1121 },
      ] as const;

      for (const block of blocks) {
        const totalRegisters = block.to - block.from + 1;
        const payload = new Array<number>(totalRegisters).fill(0);
        await this.withReconnect(() => this.client.writeRegisters(block.from, payload));
      }

      return {
        ok: true,
        message: 'Reset en bloque aplicado a D1000-D1061 y D1100-D1121.',
        resetBlocks: blocks,
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
      await this.withReconnect(() => this.client.writeCoil(coil, true));
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await this.withReconnect(() => this.client.writeCoil(coil, false));

      return {
        ok: true,
        memory: key,
        coil,
        pulseMs: 1000,
      };
    });
  }

  async close(): Promise<void> {
    await this.resetConnection();
  }
}
