import { existsSync } from 'node:fs';

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
  // Hosts extra (además de IPs privadas) a los que se permite enviar el login del router.
  routerHosts: (env.ROUTER_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
};

if (!config.adminPass) {
  console.warn('⚠️  ADMIN_PASS no está definido: el panel /admin quedará desactivado.');
}
if (!config.hotspotPass) {
  console.warn('⚠️  HOTSPOT_PASS no está definido: el portal funcionará solo en modo prueba (sin router).');
}
