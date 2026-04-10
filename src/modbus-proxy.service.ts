import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import net from 'node:net';
import {
  ENABLE_MODBUS_PROXY_SERVER,
  MODBUS_PROXY_LISTEN_HOST,
  MODBUS_PROXY_LISTEN_PORT,
  MODBUS_PROXY_TARGET_HOST,
  MODBUS_PROXY_TARGET_PORT,
} from './config';

@Injectable()
export class ModbusProxyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ModbusProxyService.name);
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();

  async onModuleInit(): Promise<void> {
    if (!ENABLE_MODBUS_PROXY_SERVER) {
      return;
    }

    this.server = net.createServer((clientSocket) => {
      const targetSocket = net.createConnection({
        host: MODBUS_PROXY_TARGET_HOST,
        port: MODBUS_PROXY_TARGET_PORT,
      });

      this.trackSocket(clientSocket);
      this.trackSocket(targetSocket);

      clientSocket.pipe(targetSocket);
      targetSocket.pipe(clientSocket);

      const closeBoth = () => {
        clientSocket.destroy();
        targetSocket.destroy();
      };

      clientSocket.on('error', (error) => {
        this.logger.warn(`Cliente proxy con error: ${error.message}`);
        closeBoth();
      });

      targetSocket.on('error', (error) => {
        this.logger.warn(`Destino PLC con error: ${error.message}`);
        closeBoth();
      });
    });

    this.server.on('error', (error) => {
      this.logger.error(`No se pudo levantar proxy Modbus: ${error.message}`);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.listen(MODBUS_PROXY_LISTEN_PORT, MODBUS_PROXY_LISTEN_HOST, () => resolve());
      this.server?.once('error', reject);
    });

    this.logger.log(
      `Proxy Modbus activo en ${MODBUS_PROXY_LISTEN_HOST}:${MODBUS_PROXY_LISTEN_PORT} -> ${MODBUS_PROXY_TARGET_HOST}:${MODBUS_PROXY_TARGET_PORT}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();

    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
    this.server = null;
  }

  private trackSocket(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => {
      this.sockets.delete(socket);
    });
  }
}
