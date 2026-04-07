import { Controller, Get, Header } from '@nestjs/common';

@Controller()
export class WebController {
  @Get('app.js')
  @Header('Content-Type', 'application/javascript; charset=utf-8')
  appScript() {
    return `const liveRows = document.getElementById('liveRows');
const analysisRows = document.getElementById('analysisRows');
const statusLive = document.getElementById('statusLive');
const statusAnalysis = document.getElementById('statusAnalysis');
const statusReset = document.getElementById('statusReset');
const dayInput = document.getElementById('day');

let timer = null;

function setText(el, text, ok = true) {
  el.textContent = text;
  el.style.color = ok ? '#14532d' : '#991b1b';
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || 'Error');
  }
  return data;
}

function trendLabel(trend) {
  if (trend === 'PARO') return 'Parada';
  if (trend === 'BAJO_VELOCIDAD') return 'Baja velocidad';
  if (trend === 'SUBIO_VELOCIDAD') return 'Subio velocidad';
  if (trend === 'ESTABLE') return 'Estable';
  return 'Sin referencia';
}

function qualityLabel(pct) {
  if (pct >= 85) return 'Alta';
  if (pct >= 60) return 'Media';
  return 'Baja';
}

function qualityClass(pct) {
  if (pct >= 85) return 'q-high';
  if (pct >= 60) return 'q-mid';
  return 'q-low';
}

function renderLive(values) {
  liveRows.innerHTML = values.map((v) =>
    '<tr>' +
      '<td>' + v.name + '</td>' +
      '<td>D' + v.address + '</td>' +
      '<td>' + v.type + '</td>' +
      '<td>' + v.value + '</td>' +
    '</tr>'
  ).join('');
}

async function loadLive() {
  try {
    const data = await fetchJson('/api/lecturas');
    renderLive(data.values);
    setText(statusLive, 'PLC ' + data.plc.ip + ':' + data.plc.port + ' | ' + new Date(data.timestamp).toLocaleString(), true);
  } catch (err) {
    setText(statusLive, 'Error lectura: ' + err.message, false);
  }
}

async function loadAnalysis() {
  const q = new URLSearchParams();
  if (dayInput.value) q.set('day', dayInput.value);

  try {
    const data = await fetchJson('/api/analysis-day-table?' + q.toString());
    analysisRows.innerHTML = '';

    if (data.noData) {
      setText(statusAnalysis, 'Sin datos para ese dia', true);
      return;
    }

    analysisRows.innerHTML = data.rows.map((r) =>
      '<tr>' +
        '<td>' + r.hour + '</td>' +
        '<td>' + r.machine + '</td>' +
        '<td>' + r.avgSpeed + ' ' + r.unit + '/s</td>' +
        '<td>' + r.productionInHour + ' ' + r.unit + '</td>' +
        '<td>' + r.stoppedSeconds + ' s</td>' +
        '<td><span class="quality ' + qualityClass(r.dataQualityPct || 0) + '">' + qualityLabel(r.dataQualityPct || 0) + ' (' + (r.dataQualityPct || 0) + '%)</span></td>' +
        '<td>' + trendLabel(r.trend) + '</td>' +
      '</tr>'
    ).join('');

    const avgQuality = data.rows.length > 0
      ? (data.rows.reduce((sum, row) => sum + (row.dataQualityPct || 0), 0) / data.rows.length).toFixed(1)
      : '0.0';

    setText(statusAnalysis, 'Filas: ' + data.rows.length + ' | Dia: ' + data.day + ' | Calidad prom: ' + avgQuality + '%', true);
  } catch (err) {
    analysisRows.innerHTML = '';
    setText(statusAnalysis, 'Error analisis: ' + err.message, false);
  }
}

async function refreshAll() {
  await Promise.all([loadLive(), loadAnalysis()]);
}

async function resetMachine(id) {
  try {
    const data = await fetchJson('/api/pulsos/' + id + '/reset', { method: 'POST' });
    setText(statusReset, data.message || 'Reset aplicado', true);
    await loadLive();
    await loadAnalysis();
  } catch (err) {
    setText(statusReset, 'Error reset: ' + err.message, false);
  }
}

function showModal() {
  document.getElementById('resetModal').style.display = 'flex';
}
function hideModal() {
  document.getElementById('resetModal').style.display = 'none';
}

async function fullReset() {
  hideModal();
  setText(statusReset, 'Ejecutando reset completo...', true);
  try {
    const data = await fetchJson('/api/full-reset', { method: 'POST' });
    setText(statusReset, data.message || 'Reset completo exitoso', true);
    analysisRows.innerHTML = '';
    setText(statusAnalysis, 'DB limpia, esperando nuevos datos...', true);
    await loadLive();
  } catch (err) {
    setText(statusReset, 'Error reset completo: ' + err.message, false);
  }
}

window.addEventListener('error', (event) => {
  setText(statusLive, 'JS error: ' + event.message + ' (' + event.filename + ':' + event.lineno + ')', false);
});

document.getElementById('btnRefresh').onclick = refreshAll;
document.getElementById('btnAnalyze').onclick = loadAnalysis;
document.getElementById('btnFullReset').onclick = showModal;
document.getElementById('modalCancel').onclick = hideModal;
document.getElementById('modalConfirm').onclick = fullReset;

document.querySelectorAll('[data-reset-id]').forEach((btn) => {
  btn.addEventListener('click', () => resetMachine(btn.getAttribute('data-reset-id')));
});

document.getElementById('auto').onchange = (e) => {
  if (e.target.checked) {
    timer = setInterval(refreshAll, 1000);
    refreshAll();
  } else if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

const now = new Date();
dayInput.value = now.toISOString().slice(0, 10);

refreshAll();
timer = setInterval(refreshAll, 1000);
`;
  }

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  index() {
    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Panel Produccion</title>
  <style>
    body { margin: 0; font-family: Segoe UI, Arial, sans-serif; background: #f3f4f6; color: #111827; }
    .wrap { max-width: 1200px; margin: 0 auto; padding: 16px; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px; margin-bottom: 12px; }
    h1 { margin: 0 0 12px; font-size: 1.35rem; }
    h2 { margin: 0 0 8px; font-size: 1.05rem; }
    .line { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
    button, input { min-height: 36px; padding: 6px 10px; border-radius: 8px; border: 1px solid #d1d5db; }
    button { cursor: pointer; background: #0f766e; color: #fff; border: none; }
    button.gray { background: #374151; }
    button.warn { background: #b91c1c; }
    .status { font-size: 0.92rem; color: #14532d; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 8px; text-align: left; font-size: 0.9rem; }
    th { background: #f9fafb; }
    .table-wrap { overflow-x: auto; }
    .quality { display: inline-block; padding: 2px 8px; border-radius: 999px; font-weight: 600; font-size: 0.82rem; }
    .q-high { background: #dcfce7; color: #166534; }
    .q-mid { background: #fef9c3; color: #854d0e; }
    .q-low { background: #fee2e2; color: #991b1b; }
    .modal-bg { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center; }
    .modal { background: #fff; border-radius: 12px; padding: 24px; max-width: 420px; width: 90%; text-align: center; box-shadow: 0 8px 30px rgba(0,0,0,0.25); }
    .modal h3 { margin: 0 0 12px; color: #991b1b; }
    .modal p { margin: 0 0 20px; font-size: 0.95rem; color: #374151; }
    .modal-btns { display: flex; gap: 10px; justify-content: center; }
    .modal-btns button { min-width: 120px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Panel Produccion Modbus</h1>

    <div class="card">
      <h2>Controles</h2>
      <div class="line">
        <button id="btnRefresh" class="gray">Refrescar lectura</button>
        <label><input id="auto" type="checkbox" checked /> Auto 1s</label>
      </div>
      <div id="statusLive" class="status">Esperando lectura...</div>
    </div>

    <div class="card">
      <h2>Reset por maquina</h2>
      <div class="line">
        <button data-reset-id="1" class="warn">Reset Telar 1</button>
        <button data-reset-id="2" class="warn">Reset Telar 2</button>
        <button data-reset-id="3" class="warn">Reset Telar 3</button>
        <button data-reset-id="4" class="warn">Reset Cortadora 1</button>
        <button data-reset-id="5" class="warn">Reset Cortadora 2</button>
        <button data-reset-id="6" class="warn">Reset Cortadora 3</button>
        <button data-reset-id="7" class="warn">Reset Cortadora 4</button>
      </div>
      <div class="line">
        <button id="btnFullReset" class="warn" style="background:#7f1d1d;margin-top:4px">Reset COMPLETO (PLC + BD)</button>
      </div>
      <div id="statusReset" class="status">Sin acciones</div>
    </div>

    <div id="resetModal" class="modal-bg">
      <div class="modal">
        <h3>Confirmar Reset Completo</h3>
        <p>Esto va a resetear los pulsos de TODAS las maquinas (D1000-D1060) y borrar TODOS los datos de la base de datos (lecturas, eventos, anomalias).<br><br><strong>Esta accion no se puede deshacer.</strong></p>
        <div class="modal-btns">
          <button id="modalCancel" class="gray">Cancelar</button>
          <button id="modalConfirm" class="warn">Si, resetear todo</button>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Analisis Diario por Horas</h2>
      <div class="line">
        <input id="day" type="date" />
        <button id="btnAnalyze">Analizar</button>
      </div>
      <div id="statusAnalysis" class="status">Sin analisis</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Horas</th>
              <th>Maquina</th>
              <th>Vel promedio (hora)</th>
              <th>Produccion en la hora</th>
              <th>Tiempo parado</th>
              <th>Calidad de datos</th>
              <th>Tendencia vs horas anteriores</th>
            </tr>
          </thead>
          <tbody id="analysisRows"></tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h2>Lectura en vivo</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Descripcion</th><th>Registro</th><th>Tipo</th><th>Valor</th></tr>
          </thead>
          <tbody id="liveRows"></tbody>
        </table>
      </div>
    </div>
  </div>
  <script src="/app.js"></script>
</body>
</html>`;
  }
}
