# Instrucciones para montar el portal (para el proveedor / administrador de Datto)

> English version below.

## Qué es

Un portal cautivo propio para el Wi-Fi de invitados. Pide los datos **de forma progresiva** (un dato nuevo
en cada conexión: correo → nombre → teléfono → fecha de nacimiento y género) y guarda todo en su propia
base de datos, con un panel de administración en `/admin`.

**No es una página HTML estática.** Necesita su servidor (Node.js) por dos razones:
1. Guardar los datos de cada persona y recordar en qué paso va.
2. Responder al AP Datto si deja pasar a cada teléfono (*HTTP Authentication API*).

## Requisitos

- Un servidor Linux con **Node.js 22.13 o más nuevo** (no necesita instalar paquetes: `npm install` no hace falta).
- Un dominio, por ejemplo `portal.ejemplo.com`, con HTTPS (en `router/datto/GUIA.md` hay un ejemplo con Caddy).
- Acceso a **Datto Network Manager** para la red donde está el AP440.

## Pasos

1. Copiar la carpeta del proyecto al servidor.
2. `cp .env.example .env` y llenar:
   - `ADMIN_USER` / `ADMIN_PASS`: acceso al panel.
   - `DATTO_UAM_SECRET`, `DATTO_AUTH_SECRET`, `FIRMA_SECRETO`: tres claves largas distintas (`openssl rand -hex 16`).
   - `ORG_NAME`, `WIFI_NAME`: textos del portal.
3. Iniciar: `npm start` (conviene dejarlo como servicio con systemd o pm2). Escucha en el puerto `PORT` (3000).
4. Publicarlo con HTTPS en el dominio, dejando **`/datto/auth` accesible también por `http://`** (ver Caddyfile en la guía).
5. En Datto Network Manager → SSID de invitados → **Captive Portal**:

| Campo | Valor |
|---|---|
| Splash page | Activado |
| Splash page type | **Hosted remotely** |
| Splash page URL | `https://portal.ejemplo.com/` |
| Splash page secret | = `DATTO_UAM_SECRET` |
| Authentication | **HTTP** |
| Authentication URL | `http://portal.ejemplo.com/datto/auth` |
| Authentication secret | = `DATTO_AUTH_SECRET` |
| Block duration | 10 minutos o más |
| Redirect URL | (vacío) |
| Walled garden | `portal.ejemplo.com` |

6. Probar con un teléfono: debe abrirse el portal pidiendo el correo, y al enviarlo, dar internet.
   Los registros aparecen en `https://portal.ejemplo.com/admin`.

Diseño: colores en `public/estilos.css` (`--color`), logo en `public/logo.png`, textos de cada paso en `src/etapas.js`.
Guía completa: `router/datto/GUIA.md`. Pruebas automáticas: `npm test`.

---

# Setup instructions (for the Datto administrator)

## What it is

A self-hosted captive portal with **progressive profiling**: each time a guest connects, it asks for one new
piece of data (email → name → phone → birthdate & gender). Data is stored in the portal's own database; admin
panel at `/admin`.

**It is not a static landing page.** It needs its Node.js server to (1) store each guest's data and progress,
and (2) answer the Datto AP through the **HTTP Authentication API**.

## Requirements

- Linux server with **Node.js ≥ 22.13** (no dependencies to install).
- A domain (e.g. `portal.example.com`) with HTTPS.
- Access to **Datto Network Manager** for the network that holds the AP440.

## Steps

1. Copy the project to the server; `cp .env.example .env` and set `ADMIN_USER`, `ADMIN_PASS`,
   `DATTO_UAM_SECRET`, `DATTO_AUTH_SECRET`, `FIRMA_SECRETO` (three distinct long random strings), `ORG_NAME`, `WIFI_NAME`.
2. Run `npm start` (as a systemd/pm2 service). Listens on `PORT` (default 3000).
3. Expose it over HTTPS; keep **`/datto/auth` reachable over plain `http://`** (Datto's HTTP Auth API
   documentation states HTTPS is not supported there — use https if your DNM version accepts it).
4. Datto Network Manager → guest SSID → **Captive Portal**:
   - Splash page: **on** · Type: **Hosted remotely** · URL: `https://portal.example.com/` · Secret: `DATTO_UAM_SECRET`
   - Authentication: **HTTP** · URL: `http://portal.example.com/datto/auth` · Secret: `DATTO_AUTH_SECRET`
   - Block duration: ≥ 10 min · Redirect URL: empty · Walled garden: `portal.example.com`
5. Test with a phone: the portal should open asking for an email; after submitting, the guest gets internet.

Protocol reference: CloudTrax/Datto external splash page (UAM) + HTTP Authentication API —
https://github.com/cloudtrax/docs/tree/master/captive_portal
