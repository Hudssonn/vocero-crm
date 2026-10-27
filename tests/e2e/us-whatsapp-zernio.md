# US — WhatsApp por Zernio en la bandeja

Guion de verificación en vivo (Principio IX). Se corre con la cuenta
sandbox de Zernio y una instancia NO productiva, nunca contra el número
vivo de un negocio. El puente n8n de la Tienda sigue vivo mientras este
guion no esté en verde: no se toca su webhook.

## Preparación

1. Instancia de pruebas con el código 032 desplegado y migración 0022
   aplicada.
2. Conexión Zernio desde Ajustes → WhatsApp → «Conectar WhatsApp por
   Zernio»: llave sandbox + cuenta de WhatsApp sandbox (la pantalla
   resuelve la cuenta sola; si la llave tiene varias, se elige).
3. Webhook de Zernio dado de alta por el CRM al guardar, limitado a la
   cuenta sandbox.

## Camino feliz

1. Desde un teléfono de prueba, mandar «Hola» al número sandbox.
2. **Verificar:** el mensaje aparece en la bandeja de la instancia de
   pruebas, en la conversación del teléfono, con su texto y su hora.
3. **Verificar:** el agente incluido responde en el hilo y la respuesta
   llega al teléfono de prueba (sale por Zernio, no por Meta directo).
4. Responder desde la bandeja como operador.
5. **Verificar:** el mensaje llega al teléfono y queda en estado `sent`
   (no con el reloj puesto).
6. Mandar el mismo mensaje otra vez con el mismo id (reentrega de Zernio).
7. **Verificar:** no se duplica en la bandeja.

## Camino infeliz

1. Mandar un mensaje a una cuenta Zernio que la instancia NO tiene
   conectada.
2. **Verificar:** no se ingiere nada y el log muestra el aviso de cuenta
   desconocida.
3. Mandar una foto sin texto.
4. **Verificar:** entra como imagen (tipo registrado, sin descargar) y la
   bandeja enseña «📎 Imagen», no pierde el mensaje.
5. Revocar la llave de Zernio y mandar un mensaje desde la bandeja.
6. **Verificar:** el envío falla con «reconecta WhatsApp» y la conexión
   queda en `reconnect_required` (no se reintenta a ciegas).
7. Mandar un mensaje cuando pasaron más de 24 h desde el último entrante.
8. **Verificar:** el envío se rechaza con `window_closed`, no sale nada.

## Criterio de cierre

Verde en los 8 pasos anteriores = la pieza de transporte está lista para
la pantalla de conexión y, después, para el corte en TEP. Cualquier paso
en rojo se diagnostica, se corrige y se vuelve a correr el guion entero.
