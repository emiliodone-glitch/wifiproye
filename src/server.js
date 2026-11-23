import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config as configPorDefecto } from './config.js';
import { abrirBaseDeDatos } from './db.js';
import { ETAPAS, etapaPendiente, validarEtapa, tituloDe } from './etapas.js';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const PUBLICO = join(RAIZ, 'public');

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

const escapar = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- Identificar el dispositivo ----------

const MAC = /^([0-9A-F]{2}[:-]){5}[0-9A-F]{2}$/i;
const COOKIE = 'wp_disp';

function limpiar(v, max = 100) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function leerCookie(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{32})`).exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

/**
 * Cómo reconocemos que es el mismo teléfono en la próxima conexión:
 * 1) por la MAC que manda el router (lo normal), o
 * 2) por una cookie, si no hay router (modo prueba) o no llegó la MAC.
 * Si se pierden las dos (MAC aleatoria nueva y sin cookie), la persona pone su correo
 * otra vez y se le reconoce por el correo: sigue donde se había quedado.
 */
function claveDispositivo(req, mac) {
  const m = limpiar(mac, 17);
  if (MAC.test(m)) return 'mac:' + m.toUpperCase().replace(/-/g, ':');
  const c = leerCookie(req);
  return c ? 'cookie:' + c : null;
}

function estadoDe(persona) {
  const etapa = etapaPendiente(persona);
  return {
    etapa: etapa?.id || null,
    paso: etapa ? ETAPAS.indexOf(etapa) + 1 : ETAPAS.length,
    total: ETAPAS.length,
    titulo: etapa ? tituloDe(etapa, persona) : null,
    nombre: persona?.nombre || null,
    nuevo: !persona,
  };
}

// ---------- Vinculación con el router ----------

function esIpPrivada(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Calcula a dónde mandar el navegador después de registrarse.
 * - Si vino del MikroTik (parámetro "login" = $(link-login-only)), se envía al router
 *   con el usuario/clave del hotspot para que abra el internet a ese dispositivo.
 * - Si no hay router (modo prueba), se manda directo a la página de destino.
 * Solo se aceptan direcciones del router en redes privadas (o en ROUTER_HOSTS) para que
 * nadie pueda usar este servidor para enviar la clave del hotspot a otro sitio.
 */
export function urlDeAcceso(cfg, { login, dst }) {
  const destino = /^https?:\/\//i.test(dst || '') ? dst : cfg.defaultRedirect;
  if (!login || !cfg.hotspotPass) return destino;
  let url;
  try {
    url = new URL(login);
  } catch {
    return destino;
  }
  const host = url.hostname.toLowerCase();
  const permitido = esIpPrivada(host) || cfg.routerHosts.includes(host);
  if (!/^https?:$/.test(url.protocol) || !permitido) return destino;
  url.searchParams.set('username', cfg.hotspotUser);
  url.searchParams.set('password', cfg.hotspotPass);
  url.searchParams.set('dst', destino);
  return url.toString();
}

// ---------- Utilidades HTTP ----------

function leerCuerpo(req, limite = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const partes = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > limite) {
        reject(new Error('demasiado grande'));
        req.destroy();
      } else partes.push(c);
    });
    req.on('end', () => {
      const texto = Buffer.concat(partes).toString('utf8');
      const tipo = req.headers['content-type'] || '';
      try {
        if (tipo.includes('application/json')) resolve(JSON.parse(texto || '{}'));
        else resolve(Object.fromEntries(new URLSearchParams(texto)));
      } catch {
        reject(new Error('cuerpo inválido'));
      }
    });
    req.on('error', reject);
  });
}

function enviar(res, estado, cuerpo, tipo, extra = {}) {
  tipo ??= 'text/html; charset=utf-8';
  res.writeHead(estado, {
    'Content-Type': tipo,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(cuerpo);
}

const json = (res, estado, obj) => enviar(res, estado, JSON.stringify(obj), 'application/json; charset=utf-8');

function igualSeguro(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function autorizadoAdmin(cfg, req) {
  if (!cfg.adminPass) return false;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, ...p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return igualSeguro(u, cfg.adminUser) && igualSeguro(p.join(':'), cfg.adminPass);
}

function ipCliente(req) {
  return req.socket.remoteAddress || '';
}

// ---------- Páginas ----------

function plantilla(nombre, cfg, extra = {}) {
  const vars = {
    ORG_NAME: cfg.orgName,
    WIFI_NAME: cfg.wifiName,
    PRIVACY_URL: cfg.privacyUrl,
    LOGO: ['logo.png', 'logo.svg', 'logo.jpg', 'logo.webp'].find((f) => existsSync(join(PUBLICO, f))) || '',
    ...extra,
  };
  return readFileSync(join(PUBLICO, nombre), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => escapar(vars[k]));
}

const csvCelda = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita fórmulas al abrir en Excel
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function paginaAdmin(db) {
  const r = db.resumen();
  const filas = db
    .listar()
    .map((x) => {
      const pend = etapaPendiente(x);
      const hechos = pend ? ETAPAS.indexOf(pend) : ETAPAS.length;
      const progreso = `<span class="progreso" title="${hechos} de ${ETAPAS.length} pasos"><i style="width:${(hechos / ETAPAS.length) * 100}%"></i></span> ${hechos}/${ETAPAS.length}`;
      return `<tr><td>${x.id}</td><td>${progreso}</td><td>${escapar(x.email)}</td>
      <td>${escapar([x.nombre, x.segundo_nombre, x.apellido].filter(Boolean).join(' '))}</td>
      <td>${x.telefono ? escapar(x.codigo_pais + ' ' + x.telefono) : ''}</td><td>${escapar(x.nacimiento || '')}</td>
      <td>${escapar(x.genero || '')}</td><td>${x.acepta_sms == null ? '' : x.acepta_sms ? 'Sí' : 'No'}</td>
      <td>${x.visitas}</td><td>${x.dispositivos}</td><td>${escapar(x.creado)}</td><td>${escapar(x.ultima_visita || '')}</td></tr>`;
    })
    .join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Panel de registros</title><link rel="stylesheet" href="/estilos.css"></head><body class="admin">
<main><h1>Registros del Wi-Fi</h1>
<div class="tarjetas"><div><b>${r.personas}</b>personas</div><div><b>${r.conexiones}</b>conexiones</div><div><b>${r.hoy}</b>conexiones hoy</div></div>
<p><a class="boton" href="/admin/registros.csv">Descargar Excel (CSV)</a></p>
<div class="tabla"><table><thead><tr><th>#</th><th>Perfil</th><th>Correo</th><th>Nombre</th><th>Teléfono</th><th>Nacimiento</th><th>Género</th><th>SMS</th><th>Visitas</th><th>Equipos</th><th>Registro (UTC)</th><th>Última visita</th></tr></thead>
<tbody>${filas || '<tr><td colspan="12">Todavía no hay registros.</td></tr>'}</tbody></table></div>
<p class="nota">Pasos: ${ETAPAS.map((e, i) => `${i + 1}. ${e.id}`).join(' · ')}. Se muestran los últimos 500; el CSV trae todos.</p></main></body></html>`;
}

// ---------- Servidor ----------

export function crearServidor(cfg = configPorDefecto, db = abrirBaseDeDatos(cfg.dbPath)) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const ruta = url.pathname;
    try {
      // Portal (formulario)
      if (req.method === 'GET' && (ruta === '/' || ruta === '/portal')) {
        const extra = {};
        if (!leerCookie(req)) {
          const seguro = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
          extra['Set-Cookie'] = `${COOKIE}=${randomBytes(16).toString('hex')}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${seguro}`;
        }
        return enviar(res, 200, plantilla('portal.html', cfg), undefined, extra);
      }

      if (req.method === 'GET' && ruta === '/privacidad') {
        return enviar(res, 200, plantilla('privacidad.html', cfg));
      }

      // ¿Qué paso le toca a este dispositivo?
      if (req.method === 'GET' && ruta === '/api/estado') {
        const clave = claveDispositivo(req, url.searchParams.get('mac'));
        return json(res, 200, estadoDe(db.personaPorDispositivo(clave)));
      }

      // Enviar el paso que tocaba y conectarse
      if (req.method === 'POST' && ruta === '/api/conectar') {
        const cuerpo = await leerCuerpo(req);
        const clave = claveDispositivo(req, cuerpo.mac);
        const ip = limpiar(cuerpo.ip, 45) || ipCliente(req);
        const ua = limpiar(req.headers['user-agent'], 300);
        let persona = db.personaPorDispositivo(clave);
        const etapa = etapaPendiente(persona);

        // La página mostraba otro paso (p. ej. dos pestañas abiertas): que se actualice.
        if ((cuerpo.etapa || null) !== (etapa?.id || null)) {
          return json(res, 409, { ok: false, estado: estadoDe(persona), errores: ['La página se actualizó, revisa los datos.'] });
        }

        if (etapa) {
          const { datos, errores } = validarEtapa(etapa, cuerpo);
          if (errores.length) return json(res, 400, { ok: false, errores });
          if (!persona) {
            // Paso 1: correo. Si el correo ya existía (otro teléfono, o cambió la MAC), se reconoce.
            persona = db.obtenerOCrearPersona(datos.email, datos.terminos_aceptados_en);
            db.vincularDispositivo(clave, persona.id, ua);
          }
          persona = db.completarPersona(persona.id, datos);
        }

        db.registrarConexion(persona.id, clave, ip, etapa?.id || 'completo');
        return json(res, 200, { ok: true, redirect: urlDeAcceso(cfg, { login: cuerpo.login, dst: cuerpo.dst }), estado: estadoDe(persona) });
      }

      // Panel de administración
      if (ruta === '/admin' || ruta === '/admin/registros.csv') {
        if (!autorizadoAdmin(cfg, req)) {
          return enviar(res, 401, 'Acceso restringido', 'text/plain; charset=utf-8', {
            'WWW-Authenticate': 'Basic realm="Panel WiFi", charset="UTF-8"',
          });
        }
        if (ruta === '/admin') return enviar(res, 200, paginaAdmin(db));
        const cols = ['id', 'creado', 'actualizado', 'email', 'nombre', 'segundo_nombre', 'apellido', 'codigo_pais',
          'telefono', 'nacimiento', 'genero', 'acepta_sms', 'terminos_aceptados_en', 'visitas'];
        const csv = '﻿' + [cols.join(','), ...db.todos().map((f) => cols.map((c) => csvCelda(f[c])).join(','))].join('\r\n');
        return enviar(res, 200, csv, 'text/csv; charset=utf-8', {
          'Content-Disposition': 'attachment; filename="registros-wifi.csv"',
        });
      }

      // Archivos estáticos (CSS, JS, logo)
      if (req.method === 'GET' && /^\/[\w.-]+$/.test(ruta) && TIPOS[extname(ruta)] && extname(ruta) !== '.html') {
        const archivo = join(PUBLICO, ruta.slice(1));
        if (existsSync(archivo)) {
          return enviar(res, 200, readFileSync(archivo), TIPOS[extname(ruta)], { 'Cache-Control': 'public, max-age=3600' });
        }
      }

      enviar(res, 404, 'No encontrado', 'text/plain; charset=utf-8');
    } catch (e) {
      console.error(e);
      if (!res.headersSent) json(res, 400, { ok: false, errores: ['Solicitud inválida.'] });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const servidor = crearServidor();
  servidor.listen(configPorDefecto.port, () => {
    console.log(`Portal escuchando en http://localhost:${configPorDefecto.port}`);
    console.log(`Panel de registros:   http://localhost:${configPorDefecto.port}/admin`);
  });
}
