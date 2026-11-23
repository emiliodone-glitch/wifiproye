import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config as configPorDefecto } from './config.js';
import { abrirBaseDeDatos } from './db.js';
import { ETAPAS, etapaPendiente, validarEtapa, tituloDe } from './etapas.js';
import { esDatto, urlLogon, responderAuth } from './routers/datto.js';

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

/**
 * Identificador de la antena/router desde la que llegó la persona:
 *  - Datto: "called" (en el portal) o "node" (en /datto/auth) = MAC del AP.
 *  - MikroTik: "ap" = nombre (identity) del router.
 */
export function idLugar(v) {
  const s = limpiar(v, 64);
  if (!s) return null;
  if (MAC.test(s)) return s.toUpperCase().replace(/-/g, ':');
  return /^[\w .-]{1,64}$/.test(s) ? s : null;
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
export function urlDeAcceso(cfg, p) {
  if (esDatto(p)) return urlLogon(cfg, p) || cfg.defaultRedirect;
  return urlMikrotik(cfg, p);
}

function urlMikrotik(cfg, { login, dst }) {
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

const nombreLugar = (l) => l.nombre || `Sin nombre (${l.ap})`;

function marcoAdmin(titulo, activa, cuerpo) {
  const enlace = (href, texto) => `<a href="${href}"${activa === href ? ' class="activa"' : ''}>${texto}</a>`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapar(titulo)}</title><link rel="stylesheet" href="/estilos.css"></head><body class="admin">
<main><nav class="menu">${enlace('/admin', 'Personas')}${enlace('/admin/lugares', 'Lugares')}</nav>
${cuerpo}</main></body></html>`;
}

function paginaAdmin(db) {
  const r = db.resumen();
  const lugares = db.lugaresPorPersona();
  const filas = db
    .listar()
    .map((x) => {
      const pend = etapaPendiente(x);
      const hechos = pend ? ETAPAS.indexOf(pend) : ETAPAS.length;
      const progreso = `<span class="progreso" title="${hechos} de ${ETAPAS.length} pasos"><i style="width:${(hechos / ETAPAS.length) * 100}%"></i></span> ${hechos}/${ETAPAS.length}`;
      const susLugares = (lugares[x.id] || []).map((l) => `${escapar(nombreLugar(l))} (${l.veces})`).join('<br>');
      return `<tr><td>${x.id}</td><td>${progreso}</td><td>${escapar(x.email)}</td>
      <td>${escapar([x.nombre, x.segundo_nombre, x.apellido].filter(Boolean).join(' '))}</td>
      <td>${x.telefono ? escapar(x.codigo_pais + ' ' + x.telefono) : ''}</td><td>${escapar(x.nacimiento || '')}</td>
      <td>${escapar(x.genero || '')}</td><td>${x.acepta_sms == null ? '' : x.acepta_sms ? 'Sí' : 'No'}</td>
      <td>${x.visitas}</td><td class="lugares">${susLugares}</td><td>${x.dispositivos}</td><td>${escapar(x.creado)}</td><td>${escapar(x.ultima_visita || '')}</td></tr>`;
    })
    .join('');
  return marcoAdmin('Panel de registros', '/admin', `<h1>Registros del Wi-Fi</h1>
<div class="tarjetas"><div><b>${r.personas}</b>personas</div><div><b>${r.conexiones}</b>conexiones</div><div><b>${r.hoy}</b>conexiones hoy</div></div>
<p><a class="boton" href="/admin/registros.csv">Descargar Excel (CSV)</a></p>
<div class="tabla"><table><thead><tr><th>#</th><th>Perfil</th><th>Correo</th><th>Nombre</th><th>Teléfono</th><th>Nacimiento</th><th>Género</th><th>SMS</th><th>Visitas</th><th>Lugares (visitas)</th><th>Equipos</th><th>Registro (UTC)</th><th>Última visita</th></tr></thead>
<tbody>${filas || '<tr><td colspan="13">Todavía no hay registros.</td></tr>'}</tbody></table></div>
<p class="nota">Pasos: ${ETAPAS.map((e, i) => `${i + 1}. ${e.id}`).join(' · ')}. Se muestran los últimos 500; el CSV trae todos.</p>`);
}

function paginaLugares(db, aviso = '') {
  const lista = db.listarLugares();
  const filas = lista
    .map((l) => `<tr${l.nombre ? '' : ' class="sin-nombre"'}>
      <td><form method="post" action="/admin/lugares" class="nombrar">
        <input type="hidden" name="ap" value="${escapar(l.ap)}">
        <input name="nombre" value="${escapar(l.nombre || '')}" placeholder="Ej.: Local Centro" maxlength="60" aria-label="Nombre del lugar">
        <button type="submit">Guardar</button></form></td>
      <td><code>${escapar(l.ap)}</code></td><td>${l.personas}</td><td>${l.conexiones}</td><td>${l.hoy}</td>
      <td>${escapar(l.primer_visto)}</td><td>${escapar(l.ultimo_visto)}</td></tr>`)
    .join('');
  return marcoAdmin('Lugares', '/admin/lugares', `<h1>Lugares</h1>
${aviso ? `<p class="aviso-ok">${escapar(aviso)}</p>` : ''}
<p class="nota">Cada antena o router aparece aquí solo, la primera vez que alguien se conecta por ella.
Ponle el nombre del lugar donde está instalada (para Datto es la MAC de la etiqueta del AP).</p>
<div class="tabla"><table><thead><tr><th>Nombre del lugar</th><th>Antena (MAC / router)</th><th>Personas</th><th>Conexiones</th><th>Hoy</th><th>Primera vez (UTC)</th><th>Última vez (UTC)</th></tr></thead>
<tbody>${filas || '<tr><td colspan="7">Todavía no se ha conectado nadie por ninguna antena.</td></tr>'}</tbody></table></div>`);
}

/** Evita que otra página web envíe formularios al panel usando la sesión del administrador. */
function mismoOrigen(req) {
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return false;
  const origen = req.headers.origin;
  if (!origen) return true;
  try {
    return new URL(origen).host === req.headers.host;
  } catch {
    return false;
  }
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

        db.registrarConexion(persona.id, clave, ip, etapa?.id || 'completo', idLugar(cuerpo.called || cuerpo.ap));
        return json(res, 200, { ok: true, redirect: urlDeAcceso(cfg, cuerpo), estado: estadoDe(persona) });
      }

      // Datto: el AP pregunta aquí si deja pasar a un teléfono (HTTP Authentication API)
      if (req.method === 'GET' && ruta === '/datto/auth') {
        const q = Object.fromEntries(url.searchParams);
        const personaDe = (mac) => db.personaPorDispositivo(claveDispositivo(req, mac));
        const cuerpo = responderAuth(cfg, q, {
          estaCompleto: (mac) => {
            const p = personaDe(mac);
            if (!p || etapaPendiente(p)) return false;
            db.registrarConexion(p.id, claveDispositivo(req, mac), q.ipv4, 'automatico', idLugar(q.node));
            return true;
          },
        });
        return enviar(res, 200, cuerpo, 'text/plain; charset=utf-8');
      }

      // Panel de administración
      if (ruta === '/admin' || ruta === '/admin/registros.csv' || ruta === '/admin/lugares') {
        if (!autorizadoAdmin(cfg, req)) {
          return enviar(res, 401, 'Acceso restringido', 'text/plain; charset=utf-8', {
            'WWW-Authenticate': 'Basic realm="Panel WiFi", charset="UTF-8"',
          });
        }
        if (ruta === '/admin') return enviar(res, 200, paginaAdmin(db));
        if (ruta === '/admin/lugares') {
          if (req.method === 'POST') {
            if (!mismoOrigen(req)) return enviar(res, 403, 'Origen no permitido', 'text/plain; charset=utf-8');
            const cuerpo = await leerCuerpo(req);
            const nombre = limpiar(cuerpo.nombre, 60);
            const ok = db.nombrarLugar(limpiar(cuerpo.ap, 64), nombre);
            return enviar(res, ok ? 200 : 404, paginaLugares(db, ok ? `Guardado: ${nombre || '(sin nombre)'}` : 'No se encontró esa antena.'));
          }
          return enviar(res, 200, paginaLugares(db));
        }
        const lugares = db.lugaresPorPersona();
        const cols = ['id', 'creado', 'actualizado', 'email', 'nombre', 'segundo_nombre', 'apellido', 'codigo_pais',
          'telefono', 'nacimiento', 'genero', 'acepta_sms', 'terminos_aceptados_en', 'visitas', 'lugares'];
        const filasCsv = db.todos().map((f) => ({
          ...f,
          lugares: (lugares[f.id] || []).map((l) => `${nombreLugar(l)} (${l.veces})`).join(' | '),
        }));
        const csv = '﻿' + [cols.join(','), ...filasCsv.map((f) => cols.map((c) => csvCelda(f[c])).join(','))].join('\r\n');
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
