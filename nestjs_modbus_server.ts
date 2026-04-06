import 'reflect-metadata';
import { Body, Controller, Get, Header, HttpException, HttpStatus, Module, Param, Post } from '@nestjs/common';
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
const HTTP_PORT = Number(process.env.PORT ?? 5434);

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

@Controller()
class WebController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  index() {
    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Panel Modbus SACOS</title>
  <style>
    :root {
      --bg: #f4f7fb;
      --card: #ffffff;
      --ink: #1e293b;
      --muted: #64748b;
      --accent: #0f766e;
      --accent-2: #0ea5e9;
      --danger: #dc2626;
      --ok: #15803d;
      --ring: #99f6e4;
      --border: #e2e8f0;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
      color: var(--ink);
      background:
        radial-gradient(1200px 400px at 10% -10%, #ccfbf1 0%, transparent 60%),
        radial-gradient(1000px 400px at 90% 0%, #e0f2fe 0%, transparent 60%),
        var(--bg);
    }
    .wrap {
      max-width: 1100px;
      margin: 0 auto;
      padding: 18px;
    }
    .head {
      background: linear-gradient(90deg, var(--accent), var(--accent-2));
      color: white;
      border-radius: 14px;
      padding: 18px;
      box-shadow: 0 10px 25px rgba(2, 132, 199, 0.18);
    }
    .head h1 {
      margin: 0;
      font-size: 1.25rem;
      letter-spacing: 0.3px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px;
      margin-top: 14px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
      box-shadow: 0 4px 14px rgba(15, 23, 42, 0.05);
    }
    .card h2 {
      margin: 0 0 10px;
      font-size: 1rem;
      color: #0f172a;
    }
    .line {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 8px;
      flex-wrap: wrap;
    }
    input, select, button {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 0.95rem;
      outline: none;
      min-height: 38px;
    }
    input:focus, select:focus {
      border-color: #14b8a6;
      box-shadow: 0 0 0 3px var(--ring);
    }
    button {
      background: #0f766e;
      color: white;
      border: none;
      cursor: pointer;
      font-weight: 600;
    }
    button.alt { background: #0369a1; }
    button.warn { background: var(--danger); }
    .muted { color: var(--muted); font-size: 0.88rem; }
    .status {
      margin-top: 8px;
      padding: 8px 10px;
      border-radius: 8px;
      font-size: 0.9rem;
      background: #ecfeff;
      border: 1px solid #99f6e4;
    }
    .ok { color: var(--ok); }
    .err { color: var(--danger); }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
      background: white;
      border-radius: 8px;
      overflow: hidden;
    }
    th, td {
      text-align: left;
      padding: 8px;
      border-bottom: 1px solid #f1f5f9;
      font-size: 0.9rem;
    }
    th { background: #f8fafc; color: #334155; }
    .chip {
      display: inline-block;
      font-size: 0.78rem;
      padding: 2px 8px;
      border-radius: 999px;
      background: #ecfeff;
      border: 1px solid #a5f3fc;
      color: #0e7490;
      margin-left: 8px;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <h1>Panel Modbus SACOS <span class="chip">NestJS + Modbus TCP</span></h1>
      <div class="muted" style="color:#dbeafe;margin-top:6px;">Lectura, escritura y reset desde una sola pantalla</div>
    </div>

    <div class="grid">
      <div class="card">
        <h2>Lecturas Generales</h2>
        <div class="line">
          <button id="btnRefresh" class="alt">Refrescar ahora</button>
          <label><input type="checkbox" id="auto" checked /> Auto cada 2s</label>
        </div>
        <div id="plcInfo" class="muted">Sin datos</div>
        <div id="statusRead" class="status">Esperando lectura...</div>
      </div>

      <div class="card">
        <h2>Escribir Perimetro</h2>
        <div class="line">
          <select id="perId">
            <option value="1">1 - Rodillo 1</option>
            <option value="2">2 - Rodillo 2</option>
            <option value="3">3 - Rodillo 3</option>
          </select>
          <input id="perVal" type="number" step="0.01" placeholder="0.51" />
          <button id="btnPer">Guardar</button>
        </div>
        <div id="statusPer" class="status">Sin cambios</div>
      </div>

      <div class="card">
        <h2>Escribir Pulsos</h2>
        <div class="line">
          <select id="pulId">
            <option value="1">1 - Telar 1</option>
            <option value="2">2 - Telar 2</option>
            <option value="3">3 - Telar 3</option>
            <option value="4">4 - Cortadora 1</option>
            <option value="5">5 - Cortadora 2</option>
            <option value="6">6 - Cortadora 3</option>
            <option value="7">7 - Cortadora 4</option>
          </select>
          <input id="pulVal" type="number" step="1" min="0" placeholder="12345" />
          <button id="btnPul">Guardar</button>
        </div>
        <div id="statusPul" class="status">Sin cambios</div>
      </div>

      <div class="card">
        <h2>Reset Memoria M</h2>
        <div class="line">
          <select id="mem">
            <option>m0</option><option>m1</option><option>m2</option><option>m3</option>
            <option>m4</option><option>m5</option><option>m6</option>
          </select>
          <button id="btnReset" class="warn">Pulso Reset</button>
        </div>
        <div id="statusReset" class="status">Sin cambios</div>
      </div>
    </div>

    <div class="card" style="margin-top:12px;">
      <h2>Tabla de Variables</h2>
      <table>
        <thead>
          <tr><th>Descripcion</th><th>Registro</th><th>Tipo</th><th>Valor</th></tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
  </div>

  <script>
    const rows = document.getElementById('rows');
    const plcInfo = document.getElementById('plcInfo');
    const statusRead = document.getElementById('statusRead');
    let timer = null;

    function setStatus(el, text, ok = true) {
      el.textContent = text;
      el.className = 'status ' + (ok ? 'ok' : 'err');
    }

    async function readAll() {
      try {
        const res = await fetch('/api/lecturas');
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Error de lectura');

        plcInfo.textContent = 'PLC ' + data.plc.ip + ':' + data.plc.port + ' | Slave ' + data.plc.slaveId + ' | ' + new Date(data.timestamp).toLocaleTimeString();
        rows.innerHTML = data.values.map(v =>
          '<tr><td>' + v.name + '</td><td>D' + v.address + '</td><td>' + v.type + '</td><td>' + v.value + '</td></tr>'
        ).join('');
        setStatus(statusRead, 'Lectura correcta');
      } catch (err) {
        setStatus(statusRead, 'Fallo lectura: ' + err.message, false);
      }
    }

    document.getElementById('btnRefresh').onclick = readAll;
    document.getElementById('auto').onchange = (e) => {
      if (e.target.checked) {
        timer = setInterval(readAll, 2000);
        readAll();
      } else {
        clearInterval(timer);
      }
    };

    document.getElementById('btnPer').onclick = async () => {
      const id = document.getElementById('perId').value;
      const value = Number(document.getElementById('perVal').value);
      const el = document.getElementById('statusPer');
      try {
        const res = await fetch('/api/perimetros/' + id, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Error');
        setStatus(el, 'OK ' + data.name + ' = ' + data.value);
        readAll();
      } catch (err) {
        setStatus(el, 'Error: ' + err.message, false);
      }
    };

    document.getElementById('btnPul').onclick = async () => {
      const id = document.getElementById('pulId').value;
      const value = Number(document.getElementById('pulVal').value);
      const el = document.getElementById('statusPul');
      try {
        const res = await fetch('/api/pulsos/' + id, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Error');
        setStatus(el, 'OK ' + data.name + ' = ' + data.value);
        readAll();
      } catch (err) {
        setStatus(el, 'Error: ' + err.message, false);
      }
    };

    document.getElementById('btnReset').onclick = async () => {
      const mem = document.getElementById('mem').value;
      const el = document.getElementById('statusReset');
      try {
        const res = await fetch('/api/reset/' + mem, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Error');
        setStatus(el, 'Reset aplicado a ' + data.memory + ' (' + data.pulseMs + ' ms)');
      } catch (err) {
        setStatus(el, 'Error: ' + err.message, false);
      }
    };

    timer = setInterval(readAll, 2000);
    readAll();
  </script>
</body>
</html>`;
  }
}

@Module({
  controllers: [ModbusController, WebController],
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

  await app.listen(HTTP_PORT);
  console.log(`NestJS Modbus server arriba en http://localhost:${HTTP_PORT}`);
}

bootstrap().catch((error) => {
  console.error('Error fatal al iniciar servidor:', error);
  process.exit(1);
});
