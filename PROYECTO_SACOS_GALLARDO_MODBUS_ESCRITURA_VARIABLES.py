import time
from pymodbus.client import ModbusTcpClient
from pymodbus.constants import Endian
from pymodbus.payload import BinaryPayloadBuilder

# --- CONFIGURACIÓN DE RED ---
IP_PLC = "192.168.100.64"
PUERTO = 502

# MAPEO DE REGISTROS DE PERÍMETRO (D1070, D1080, D1090)
PERIMETROS = {
    "1": {"address": 1070, "name": "Rodillo 1"},
    "2": {"address": 1080, "name": "Rodillo 2"},
    "3": {"address": 1090, "name": "Rodillo 3"}
}

def escribir_perimetro():
    """Programa para ajustar perímetros de rodillo (Float 32-bit)."""
    # Inicializamos el cliente fuera del bucle para mayor eficiencia
    client = ModbusTcpClient(IP_PLC, port=PUERTO, timeout=3)
    
    print("====================================================")
    print("   AJUSTE DE PERÍMETROS (VERSIÓN ESTABLE)           ")
    print("====================================================")

    try:
        while True:
            # Mostrar menú de selección
            print("\nID | RODILLO")
            print("---+-----------")
            for key, info in PERIMETROS.items():
                print(f" {key} | {info['name']} (D{info['address']})")
            
            seleccion = input("\nSeleccione ID o 'salir': ").strip().lower()
            if seleccion == 'salir': 
                break
            
            if seleccion in PERIMETROS:
                # BUCLE DE VALIDACIÓN: No sale hasta que el número sea correcto
                while True:
                    entrada = input(f"Nuevo perímetro para {PERIMETROS[seleccion]['name']} (ej: 0.51): ").strip()
                    try:
                        # Python usa el punto (.) como separador decimal por defecto
                        valor_f = float(entrada)
                        valor_f = round(valor_f, 2) # Limitamos a 2 decimales
                        break 
                    except ValueError:
                        print(f"⚠️ ERROR: '{entrada}' no es válido. Use punto (.) para decimales.")

                # PROCESO DE ESCRITURA MODBUS
                if client.connect():
                    try:
                        # 1. Configuramos el constructor de paquetes
                        # byteorder=BIG y wordorder=LITTLE aplica el "Word Swap" necesario para tu PLC
                        builder = BinaryPayloadBuilder(byteorder=Endian.BIG, wordorder=Endian.LITTLE)
                        
                        # 2. Agregamos el valor flotante de 32 bits
                        builder.add_32bit_float(valor_f)
                        
                        # 3. Convertimos a lista de registros (Lista de enteros de 16 bits)
                        # Esto soluciona el error 'required argument is not an integer'
                        payload = builder.to_registers() 
                        
                        # 4. Enviamos los registros al PLC
                        # address: Dirección inicial, payload: los 2 registros, slave: ID del dispositivo
                        address = PERIMETROS[seleccion]['address']
                        client.write_registers(address, payload, slave=1)
                        
                        print(f"[✅] ACTUALIZADO: {PERIMETROS[seleccion]['name']} a {valor_f}")
                    
                    except Exception as e:
                        print(f"❌ Error durante la escritura: {e}")
                else:
                    print(f"❌ ERROR: No se pudo establecer conexión con el PLC en {IP_PLC}")
            else:
                print("⚠️ ID no válido. Por favor, elija 1, 2 o 3.")

    except KeyboardInterrupt:
        print("\nPrograma interrumpido por el usuario.")
    
    finally:
        # Cerramos la conexión al salir del programa para liberar el socket del PLC
        client.close()
        print("Conexión cerrada.")

if __name__ == "__main__":
    escribir_perimetro()