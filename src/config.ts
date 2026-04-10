function envBool(name: string, fallback = false): boolean {
	const raw = process.env[name];
	if (!raw) return fallback;
	const v = raw.trim().toLowerCase();
	return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export const IP_PLC = process.env.PLC_IP ?? '192.168.100.64';
export const PLC_PORT = Number(process.env.PLC_PORT ?? 502);
export const PLC_SLAVE_ID = Number(process.env.PLC_SLAVE_ID ?? 1);
export const PLC_TIMEOUT_MS = Number(process.env.PLC_TIMEOUT_MS ?? 3000);

// Cliente Modbus: permite enrutar via proxy remoto sin tocar codigo.
export const USE_MODBUS_PROXY = envBool('USE_MODBUS_PROXY', false);
export const MODBUS_PROXY_HOST = process.env.MODBUS_PROXY_HOST ?? '127.0.0.1';
export const MODBUS_PROXY_PORT = Number(process.env.MODBUS_PROXY_PORT ?? 1502);
export const MODBUS_CONNECT_HOST = USE_MODBUS_PROXY ? MODBUS_PROXY_HOST : IP_PLC;
export const MODBUS_CONNECT_PORT = USE_MODBUS_PROXY ? MODBUS_PROXY_PORT : PLC_PORT;

// Servidor proxy opcional (para correr en la maquina que si ve el PLC).
export const ENABLE_MODBUS_PROXY_SERVER = envBool('ENABLE_MODBUS_PROXY_SERVER', false);
export const MODBUS_PROXY_LISTEN_HOST = process.env.MODBUS_PROXY_LISTEN_HOST ?? '0.0.0.0';
export const MODBUS_PROXY_LISTEN_PORT = Number(process.env.MODBUS_PROXY_LISTEN_PORT ?? 1502);
export const MODBUS_PROXY_TARGET_HOST = process.env.MODBUS_PROXY_TARGET_HOST ?? IP_PLC;
export const MODBUS_PROXY_TARGET_PORT = Number(process.env.MODBUS_PROXY_TARGET_PORT ?? PLC_PORT);

export const HTTP_PORT = Number(process.env.PORT ?? 5434);
export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 1000);
export const DB_FILE = process.env.DB_FILE ?? 'modbus_history.db';
export const HEARTBEAT_INTERVAL_S = Number(process.env.HEARTBEAT_INTERVAL_S ?? 5);
