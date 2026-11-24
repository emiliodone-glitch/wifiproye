import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

// Lee el archivo .env si existe (Node 22 lo trae incorporado).
if (existsSync('.env')) process.loadEnvFile('.env');

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  adminUser: env.ADMIN_USER || 'admin',
  adminPass: env.ADMIN_PASS || '',
  hotspotUser: env.HOTSPOT_USER || 'invitado',
  hotspotPass: env.HOTSPOT_PASS || '',
  dbPath: env.DB_PATH || './data/registros.db',
  orgName: env.ORG_NAME || 'Mi Organización',
  wifiName: env.WIFI_NAME || 'WiFi Gratis',
  privacyUrl: env.PRIVACY_URL || '/privacidad',
  defaultRedirect: env.DEFAULT_REDIRECT || 'https://www.google.com',
  // ---- Datto Networking (AP440, etc.) ----
  // "Splash page secret" (UAM) y "Authentication secret" (HTTP API) de Datto Network Manager.
  dattoUamSecret: env.DATTO_UAM_SECRET || '',
  dattoAuthSecret: env.DATTO_AUTH_SECRET || '',
  // Clave interna para firmar los accesos de un solo uso (si no se define, se crea al arrancar).
  firmaSecreto: env.FIRMA_SECRETO || randomBytes(32).toString('hex'),
  // Cuánto dura cada sesión antes de que el teléfono vuelva a pasar por el portal.
  sesionSegundos: Number(env.SESION_MINUTOS || 120) * 60,
  bajadaKbps: Number(env.BAJADA_KBPS || 5000),
  subidaKbps: Number(env.SUBIDA_KBPS || 2000),
  // Personas con todos sus datos: entran directo, sin ver el portal.
  autoConectarCompletos: (env.AUTO_CONECTAR_COMPLETOS || 'si') !== 'no',

  // Hosts extra (además de IPs privadas) a los que se permite enviar el login del router.
  routerHosts: (env.ROUTER_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
};

if (!config.adminPass) {
  console.warn('[aviso] ADMIN_PASS no está definido: el panel /admin quedará desactivado.');
}
if (!config.hotspotPass && !config.dattoUamSecret) {
  console.warn('[aviso] No hay router configurado (DATTO_UAM_SECRET o HOTSPOT_PASS): el portal funcionará en modo prueba.');
}
if (config.dattoUamSecret && !config.dattoAuthSecret) {
  console.warn('[aviso] Falta DATTO_AUTH_SECRET: el AP Datto no podrá validar los accesos.');
}
