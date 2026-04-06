import time
import os
import sys
import logging
import warnings


# 1. Ignora avisos de funciones que cambiarán en versiones futuras (Deprecation)
warnings.filterwarnings("ignore", category=DeprecationWarning) 
# 2. Configura el log de Modbus para que solo muestre errores críticos
logging.getLogger("pymodbus").setLevel(logging.ERROR)

from pymodbus.client import ModbusTcpClient
from pymodbus.constants import Endian
from pymodbus.payload import BinaryPayloadDecoder

# --- CONFIGURACIÓN DE RED ---
IP_PLC = "192.168.100.64"
PUERTO = 502

# =================================================================
# MAPEO DE TODAS LAS VARIABLES (LECTURA DE 32 BITS)
# =================================================================
LECTURAS = [
    {"address": 1000, "name": "Pulsos Telar 1", "type": "int32"},
    {"address": 1010, "name": "Pulsos Telar 2", "type": "int32"},
    {"address": 1020, "name": "Pulsos Telar 3", "type": "int32"},
    {"address": 1030, "name": "Pulsos Cortadora 1", "type": "int32"},
    {"address": 1040, "name": "Pulsos Cortadora 2", "type": "int32"},
    {"address": 1050, "name": "Pulsos Cortadora 3", "type": "int32"},
    {"address": 1060, "name": "Pulsos Cortadora 4", "type": "int32"},
    # Variables de Perímetro (Float)
    {"address": 1070, "name": "Perimetro Rodillo 1", "type": "float32"},
    {"address": 1080, "name": "Perimetro Rodillo 2", "type": "float32"},
    {"address": 1090, "name": "Perimetro Rodillo 3", "type": "float32"},
    # Variables de Metros (Float)
    {"address": 1100, "name": "Metros Tejidos T1", "type": "float32"},
    {"address": 1110, "name": "Metros Tejidos T2", "type": "float32"},
    {"address": 1120, "name": "Metros Tejidos T3", "type": "float32"},
    # Variables de Sacos (Enteros)
    {"address": 1130, "name": "Sacos Cortadora 1", "type": "int32"},
    {"address": 1140, "name": "Sacos Cortadora 2", "type": "int32"},
    {"address": 1150, "name": "Sacos Cortadora 3", "type": "int32"},
    {"address": 1160, "name": "Sacos Cortadora 4", "type": "int32"}
]

def monitor():
    """Función para visualizar datos sin parpadeo y sin avisos de sistema."""
    client = ModbusTcpClient(IP_PLC, port=PUERTO, timeout=2)
    
    # Limpieza inicial de la consola
    os.system('cls' if os.name == 'nt' else 'clear')

    try:
        while True:
            # Intento de conexión
            if not client.connect():
                # \033[H posiciona el cursor al inicio para sobreescribir
                sys.stdout.write("\033[H")
                print(f"⚠️  ESTADO: Buscando PLC en {IP_PLC}...          ")
                time.sleep(2)
                continue

            # Construcción del bloque de texto (Buffer)
            buffer = "\033[H"
            buffer += "====================================================\n"
            buffer += "           RESUMEN GENERAL DE PRODUCCIÓN            \n"
            buffer += f"   IP: {IP_PLC} | Reloj: {time.strftime('%H:%M:%S')}         \n"
            buffer += "====================================================\n"
            buffer += f"{'DESCRIPCIÓN':<22} | {'REGISTRO':<8} | {'VALOR'}\n"
            buffer += "----------------------------------------------------\n"
            
            for item in LECTURAS:
                # Leemos 2 registros (32 bits)
                resp = client.read_holding_registers(address=item["address"], count=2, slave=1)
                
                if not resp.isError():
                    # Decodificación con Word Swap (LITTLE) para corregir el 0.51
                    decoder = BinaryPayloadDecoder.fromRegisters(
                        resp.registers, 
                        byteorder=Endian.BIG, 
                        wordorder=Endian.LITTLE
                    )
                    
                    # Seleccionamos el método según el tipo de dato
                    if item["type"] == "float32":
                        valor = round(decoder.decode_32bit_float(), 2)
                    else:
                        valor = decoder.decode_32bit_uint()
                else:
                    valor = "ERROR_COM"
                
                # Agregamos la línea formateada al buffer
                buffer += f"{item['name']:<22} | D{item['address']:<7} | {valor:<10}\n"
            
            buffer += "====================================================\n"
            buffer += " [Ctrl+C] para cerrar | Refresco cada 2 segundos.   \n"

            # Imprimimos todo el bloque de una sola vez
            sys.stdout.write(buffer)
            sys.stdout.flush()
            
            time.sleep(2)
            
    except KeyboardInterrupt:
        print("\n\n[!] Monitor detenido correctamente.")
    finally:
        client.close()

if __name__ == "__main__":
     monitor()