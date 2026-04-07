import { Controller, Get, Header } from '@nestjs/common';

@Controller()
export class WebController {
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
      --bg: #eef6ff;
      --card: #ffffff;
      --ink: #0f172a;
      --muted: #64748b;
      --accent: #0f766e;
      --accent-2: #0369a1;
      --danger: #b91c1c;
      --ok: #166534;
      --ring: #99f6e4;
      --border: #dbeafe;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
      color: var(--ink);
      background:
        radial-gradient(1000px 300px at 0% 0%, #ccfbf1 0%, transparent 60%),
        radial-gradient(1000px 300px at 100% 0%, #dbeafe 0%, transparent 60%),
        var(--bg);
    }
    .wrap { max-width: 1150px; margin: 0 auto; padding: 16px; }
    .head {
      background: linear-gradient(90deg, var(--accent), var(--accent-2));
      color: white;
      border-radius: 14px;
      padding: 16px;
      box-shadow: 0 10px 24px rgba(14, 116, 144, 0.2);
    }
    .head h1 { margin: 0; font-size: 1.25rem; }
    .head p { margin: 6px 0 0; opacity: 0.9; }
    .grid {
      margin-top: 12px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
      box-shadow: 0 4px 14px rgba(15, 23, 42, 0.06);
    }
    .card h2 { margin: 0 0 10px; font-size: 1rem; }
    .line { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
    input, select, button {
      min-height: 38px;
      border-radius: 8px;
      border: 1px solid #cbd5e1;
      padding: 8px 10px;
      font-size: 0.92rem;
      outline: none;
    }
    input:focus, select:focus { border-color: #14b8a6; box-shadow: 0 0 0 3px var(--ring); }
    button { border: none; color: white; background: var(--accent); font-weight: 600; cursor: pointer; }
    button.alt { background: var(--accent-2); }
    button.warn { background: var(--danger); }
    .status {
      margin-top: 6px;
      padding: 8px 10px;
      border-radius: 8px;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      font-size: 0.88rem;
      color: #334155;
      white-space: pre-wrap;
    }
    .ok { color: var(--ok); }
    .err { color: var(--danger); }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #e2e8f0; font-size: 0.88rem; }
    th { background: #f8fafc; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <h1>Panel Modbus SACOS</h1>
      <p>Registro automatico cada 2 segundos en SQLite + analisis de paros y baja de velocidad</p>
    </div>

    <div class="grid">
      <div class="card">
        <h2>Lectura en Vivo</h2>
        <div class="line">
          <button id="btnRefresh" class="alt">Refrescar</button>
          <label><input id="auto" type="checkbox" checked /> Auto 2s</label>
        </div>
        <div id="plcInfo" class="status">Esperando...</div>
      </div>

      <div class="card">
        <h2>Reset General de Pulsos</h2>
        <div class="line">
          <button id="btnResetStart" class="warn">Reset 1000-1060 e iniciar registro</button>
        </div>
        <div id="statusResetStart" class="status">Sin accion</div>
      </div>

      <div class="card">
        <h2>Perimetro</h2>
        <div class="line">
          <select id="perId"><option value="1">1 - Rodillo 1</option><option value="2">2 - Rodillo 2</option><option value="3">3 - Rodillo 3</option></select>
          <input id="perVal" type="number" step="0.01" placeholder="0.51" />
          <button id="btnPer">Guardar</button>
        </div>
        <div id="statusPer" class="status">Sin cambios</div>
      </div>

      <div class="card">
        <h2>Pulsos Manual</h2>
        <div class="line">
          <select id="pulId">
            <option value="1">1 - Telar 1</option><option value="2">2 - Telar 2</option><option value="3">3 - Telar 3</option>
            <option value="4">4 - Cortadora 1</option><option value="5">5 - Cortadora 2</option><option value="6">6 - Cortadora 3</option>
            <option value="7">7 - Cortadora 4</option>
          </select>
          <input id="pulVal" type="number" min="0" step="1" placeholder="1234" />
          <button id="btnPul">Guardar</button>
        </div>
        <div id="statusPul" class="status">Sin cambios</div>
      </div>

      <div class="card">
        <h2>Analisis Noche / Intervalo</h2>
        <div class="line">
          <input id="from" type="datetime-local" />
          <input id="to" type="datetime-local" />
          <button id="btnAnalysis" class="alt">Analizar</button>
        </div>
        <div id="statusAnalysis" class="status">Sin datos</div>
      </div>
    </div>

    <div class="card" style="margin-top:12px;">
      <h2>Variables</h2>
      <table>
        <thead><tr><th>Descripcion</th><th>Registro</th><th>Tipo</th><th>Valor</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
  </div>

  <script>
    const rows = document.getElementById('rows');
    const plcInfo = document.getElementById('plcInfo');
    let timer = null;

    function stampFromLocal(value) {
      if (!value) return '';
      const d = new Date(value);
      return Math.floor(d.getTime() / 1000).toString();
    }

    function setStatus(id, text, ok = true) {
      const el = document.getElementById(id);
      el.textContent = text;
      el.className = 'status ' + (ok ? 'ok' : 'err');
    }

    async function readAll() {
      try {
        const res = await fetch('/api/lecturas');
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Error');

        plcInfo.textContent = 'PLC ' + data.plc.ip + ':' + data.plc.port + ' | ' + new Date(data.timestamp).toLocaleString();
        rows.innerHTML = data.values.map(v =>
          '<tr><td>' + v.name + '</td><td>D' + v.address + '</td><td>' + v.type + '</td><td>' + v.value + '</td></tr>'
        ).join('');
      } catch (err) {
        setStatus('plcInfo', 'Fallo lectura: ' + err.message, false);
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

    document.getElementById('btnResetStart').onclick = async () => {
      try {
        const res = await fetch('/api/pulsos/reset-all-start', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Error');
        setStatus('statusResetStart', data.message, true);
        readAll();
      } catch (err) {
        setStatus('statusResetStart', 'Error: ' + err.message, false);
      }
    };

    document.getElementById('btnPer').onclick = async () => {
      const id = document.getElementById('perId').value;
      const value = Number(document.getElementById('perVal').value);
      try {
        const res = await fetch('/api/perimetros/' + id, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Error');
        setStatus('statusPer', 'OK ' + data.name + ' = ' + data.value, true);
        readAll();
      } catch (err) {
        setStatus('statusPer', 'Error: ' + err.message, false);
      }
    };

    document.getElementById('btnPul').onclick = async () => {
      const id = document.getElementById('pulId').value;
      const value = Number(document.getElementById('pulVal').value);
      try {
        const res = await fetch('/api/pulsos/' + id, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Error');
        setStatus('statusPul', 'OK ' + data.name + ' = ' + data.value, true);
        readAll();
      } catch (err) {
        setStatus('statusPul', 'Error: ' + err.message, false);
      }
    };

    document.getElementById('btnAnalysis').onclick = async () => {
      const from = stampFromLocal(document.getElementById('from').value);
      const to = stampFromLocal(document.getElementById('to').value);
      const q = new URLSearchParams();
      if (from) q.set('from', from);
      if (to) q.set('to', to);

      try {
        const res = await fetch('/api/analysis?' + q.toString());
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Error');

        const text = [
          'Muestras: ' + data.samples,
          'PARO total (s): ' + data.overall.stoppedSeconds,
          'BAJA velocidad total (s): ' + data.overall.lowSpeedSeconds,
          'Velocidad prom: ' + data.overall.avgSpeed,
          'Velocidad min/max: ' + data.overall.minSpeed + ' / ' + data.overall.maxSpeed,
          '',
          'Detalle por maquina:',
          ...data.byMachine.map(m => 'D' + m.address + ' -> paro=' + m.stoppedSeconds + 's, baja=' + m.lowSpeedSeconds + 's, avg=' + m.avgSpeed)
        ].join('\n');
        setStatus('statusAnalysis', text, true);
      } catch (err) {
        setStatus('statusAnalysis', 'Error: ' + err.message, false);
      }
    };

    const now = new Date();
    const before = new Date(now.getTime() - 8 * 3600 * 1000);
    document.getElementById('to').value = now.toISOString().slice(0, 16);
    document.getElementById('from').value = before.toISOString().slice(0, 16);

    timer = setInterval(readAll, 2000);
    readAll();
  </script>
</body>
</html>`;
  }
}
