# Guía: Datto AP440 + nuestro portal

El **Datto AP440** es un punto de acceso Wi-Fi 6 **administrado desde la nube**: no se configura
entrando a una IP como un router casero, sino desde la web **Datto Network Manager (DNM)**.
El **DNW-POE1** es solo la fuente de poder: le da corriente al AP por el mismo cable de red (PoE).

---

## 1. Conexión física

```
 Toma de corriente
        │
  ┌─────┴──────┐  puerto "LAN" / "DATA IN"    ┌──────────────────────┐
  │  DNW-POE1  │◄─────────────────────────────│ Router/módem con     │
  │ (adaptador)│                              │ internet (el que ya  │
  └─────┬──────┘                              │ tienen en el local)  │
        │ puerto "PoE" / "DATA+POWER OUT"     └──────────────────────┘
        ▼
  ┌────────────┐
  │   AP440    │  ← emite el Wi-Fi "WiFi Gratis"
  └────────────┘
```

- Un cable de red va del **router con internet** al puerto de datos del adaptador.
- Otro cable va del puerto **PoE** del adaptador al AP440.
- El AP enciende con ese cable (no lleva otro cargador). Puede tardar 2–5 minutos en estar listo.
- ⚠️ Nunca conectes el puerto PoE a una computadora o router: lleva 54 V.

## 2. Dar de alta el AP en Datto Network Manager

1. Entrar a Datto Network Manager con la cuenta de quien administra los equipos.
   Datto vende a través de empresas de soporte (MSP), así que **la cuenta la suele tener
   quien les dio el equipo**. Si el AP ya está registrado en la cuenta de otra empresa, no
   lo podrán agregar a una cuenta nueva hasta que esa empresa lo libere: **pregunten esto primero**.
2. Agregar el AP a una red usando el **número de serie / MAC** de la etiqueta del AP440.
3. Cuando el AP sale "en línea" en el panel, seguir con el paso 3.

## 3. Configurar la red de invitados con nuestro portal

En DNM → la red → **SSID** (por ejemplo, el SSID 2):

**Pestaña general**
- Nombre (SSID): `WiFi Gratis` (o el que quieran) · **sin contraseña** (abierta).
- Modo de red: **NAT** (el AP reparte las IP a los invitados y los separa de la red del local).

**Pestaña Captive Portal**

| Campo en Datto | Qué poner |
|---|---|
| Splash page | **Activado** |
| Splash page type | **Hosted remotely** (UAM) |
| Splash page URL | `https://portal.tudominio.com/` |
| Splash page secret | El mismo valor de `DATTO_UAM_SECRET` del `.env` |
| Authentication | **HTTP** (HTTP Authentication API) |
| Authentication URL | `http://portal.tudominio.com/datto/auth` (ver nota de HTTPS abajo) |
| Authentication secret | El mismo valor de `DATTO_AUTH_SECRET` del `.env` |
| Block duration | **10 minutos o más** (es lo que dura válido cada "challenge") |
| Redirect URL | Vacío (la persona sigue a la página que quería abrir) |
| Walled garden | `portal.tudominio.com` (para poder abrir el portal antes de tener internet) |

Guardar. Los cambios llegan al AP en unos minutos.

> **Nota de HTTPS:** la documentación de Datto/CloudTrax dice que la *Authentication URL* debe ser
> **http://** (sin S). Es una conversación entre el AP y el servidor, la persona nunca la ve, y
> está firmada con el secreto. El portal que ve la gente sí va con **https://**.
> Si su versión de Datto Network Manager acepta https:// en ese campo, úsenlo.

## 4. Qué pasa cuando alguien se conecta

```
Teléfono ──conecta──► AP440 ──"¿conoces esta MAC?" (type=status)──► nuestro servidor
                                 ◄── NO (le faltan datos) / SÍ (perfil completo) ──
   Si NO: el AP abre la ventanita con https://portal.tudominio.com/?res=notyet&mac=..&challenge=..
   La persona llena SOLO el paso que le toca (correo → nombre → teléfono → detalles)
   Nuestro servidor guarda el dato y manda el navegador a  http://<AP>:<puerto>/logon?username=..&password=..
   El AP pregunta (type=login) ──► nuestro servidor verifica la firma ──► ACCEPT
   El AP abre el internet durante SESION_MINUTOS (por defecto 120)
   Al vencer la sesión, el AP vuelve a preguntar → la persona ve el siguiente paso.
   Con el perfil completo, el AP la deja pasar directo, sin ver el portal.
```

## 5. Ajustes del servidor (`.env`)

```
DATTO_UAM_SECRET=<clave larga 1>      # igual que "Splash page secret"
DATTO_AUTH_SECRET=<clave larga 2>     # igual que "Authentication secret"
FIRMA_SECRETO=<clave larga 3>         # interna, no va en Datto
SESION_MINUTOS=120                    # cada cuánto vuelve a pasar por el portal
AUTO_CONECTAR_COMPLETOS=si            # perfil completo = entra sin portal
BAJADA_KBPS=5000                      # velocidad máx. por persona
SUBIDA_KBPS=2000
```

Generar claves: `openssl rand -hex 16` (una distinta para cada una).

## 6. Publicar el servidor con Caddy (HTTPS para el portal, HTTP solo para /datto/auth)

`/etc/caddy/Caddyfile`:

```
portal.tudominio.com {
    reverse_proxy localhost:3000
}

http://portal.tudominio.com {
    handle /datto/auth* {
        reverse_proxy localhost:3000
    }
    handle {
        redir https://{host}{uri} permanent
    }
}
```

## 7. Prueba

1. Con un teléfono, conectarse a `WiFi Gratis`: debe abrirse solo el portal pidiendo el correo.
2. Llenarlo → debe dar internet.
3. En `https://portal.tudominio.com/admin` debe aparecer el registro con 1/4.
4. Para probar el siguiente paso sin esperar 2 horas, pongan `SESION_MINUTOS=2` mientras prueban.

**Si no se abre el portal:** revisar que el dominio esté en *Walled garden*. En Android, Datto
recomienda que la Splash page URL sea accesible y que el teléfono no tenga "DNS privado" activado.
**Si el portal abre pero no da internet:** revisar que los dos secretos sean exactamente iguales en
Datto y en `.env`, y que `http://portal.tudominio.com/datto/auth` responda desde internet.
