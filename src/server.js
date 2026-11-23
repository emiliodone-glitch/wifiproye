import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config as configPorDefecto } from './config.js';
import { abrirBaseDeDatos } from './db.js';

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

// ---------- Validación ----------

const MAC = /^([0-9A-F]{2}[:-]){5}[0-9A-F]{2}$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

function limpiar(v, max = 100) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export function validarRegistro(entrada) {
  const errores = [];
  const d = {
    email: limpiar(entrada.email, 254).toLowerCase(),
    nombre: limpiar(entrada.nombre),
    segundo_nombre: limpiar(entrada.segundo_nombre) || null,
    apellido: limpiar(entrada.apellido),
    codigo_pais: limpiar(entrada.codigo_pais, 5) || '+1',
    telefono: limpiar(entrada.telefono, 30).replace(/[^\d]/g, ''),
    nacimiento: limpiar(entrada.nacimiento, 10) || null,
    genero: ['femenino', 'masculino', 'otro'].includes(entrada.genero) ? entrada.genero : null,
    acepta_sms: entrada.acepta_sms === true || entrada.acepta_sms === 'on' || entrada.acepta_sms === '1' ? 1 : 0,
  };
  const aceptaTerminos = entrada.acepta_terminos === true || entrada.acepta_terminos === 'on' || entrada.acepta_terminos === '1';

  if (!EMAIL.test(d.email)) errores.push('Escribe un correo electrónico válido.');
  if (!d.nombre) errores.push('Escribe tu nombre.');
  if (!d.apellido) errores.push('Escribe tu apellido.');
  if (!/^\+\d{1,4}$/.test(d.codigo_pais)) errores.push('Código de país inválido.');
  if (d.telefono.length < 7 || d.telefono.length > 15) errores.push('Escribe un número de teléfono válido.');
  if (d.nacimiento) {
    const f = new Date(d.nacimiento + 'T00:00:00Z');
    const hoy = new Date();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.nacimiento) || isNaN(f) || f > hoy || f.getUTCFullYear() < 1900) {
      errores.push('Fecha de nacimiento inválida.');
    }
  }
  if (!aceptaTerminos) errores.push('Debes aceptar los términos y la política de privacidad.');

  return { datos: d, errores };
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

function enviar(res, estado, cuerpo, tipo = 'text/html; charset=utf-8', extra = {}) {
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
    .map(
      (x) => `<tr><td>${x.id}</td><td>${escapar(x.creado)}</td><td>${escapar(x.nombre)} ${escapar(x.segundo_nombre || '')} ${escapar(x.apellido)}</td>
      <td>${escapar(x.email)}</td><td>${escapar(x.codigo_pais)} ${escapar(x.telefono)}</td><td>${escapar(x.nacimiento || '')}</td>
      <td>${escapar(x.genero || '')}</td><td>${x.acepta_sms ? 'Sí' : 'No'}</td><td>${escapar(x.mac || '')}</td><td>${x.visitas}</td></tr>`
    )
    .join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Panel de registros</title><link rel="stylesheet" href="/estilos.css"></head><body class="admin">
<main><h1>Registros del Wi-Fi</h1>
<div class="tarjetas"><div><b>${r.registros}</b>registros</div><div><b>${r.hoy}</b>hoy</div><div><b>${r.conexiones}</b>conexiones</div></div>
<p><a class="boton" href="/admin/registros.csv">Descargar Excel (CSV)</a></p>
<div class="tabla"><table><thead><tr><th>#</th><th>Fecha (UTC)</th><th>Nombre</th><th>Correo</th><th>Teléfono</th><th>Nacimiento</th><th>Género</th><th>SMS</th><th>MAC</th><th>Visitas</th></tr></thead>
<tbody>${filas || '<tr><td colspan="10">Todavía no hay registros.</td></tr>'}</tbody></table></div>
<p class="nota">Se muestran los últimos 500. El CSV trae todos.</p></main></body></html>`;
}

// ---------- Servidor ----------

export function crearServidor(cfg = configPorDefecto, db = abrirBaseDeDatos(cfg.dbPath)) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const ruta = url.pathname;
    try {
      // Portal (formulario)
      if (req.method === 'GET' && (ruta === '/' || ruta === '/portal')) {
        return enviar(res, 200, plantilla('portal.html', cfg));
      }

      if (req.method === 'GET' && ruta === '/privacidad') {
        return enviar(res, 200, plantilla('privacidad.html', cfg));
      }

      // ¿Este dispositivo ya se registró antes?
      if (req.method === 'GET' && ruta === '/api/estado') {
        const mac = limpiar(url.searchParams.get('mac'), 17);
        const r = MAC.test(mac) ? db.buscarPorMac(mac.toUpperCase()) : undefined;
        return json(res, 200, { registrado: !!r, nombre: r?.nombre || null });
      }

      // Registro nuevo
      if (req.method === 'POST' && ruta === '/api/registro') {
        const cuerpo = await leerCuerpo(req);
        const quiereJson = (req.headers.accept || '').includes('application/json');
        const { datos, errores } = validarRegistro(cuerpo);
        if (errores.length) {
          if (quiereJson) return json(res, 400, { ok: false, errores });
          return enviar(res, 400, `<p>${errores.map(escapar).join('<br>')}</p><p><a href="javascript:history.back()">Volver</a></p>`);
        }
        const mac = limpiar(cuerpo.mac, 17);
        db.guardarRegistro({
          ...datos,
          mac: MAC.test(mac) ? mac.toUpperCase() : null,
          ip: limpiar(cuerpo.ip, 45) || ipCliente(req),
          user_agent: limpiar(req.headers['user-agent'], 300),
        });
        const destino = urlDeAcceso(cfg, { login: cuerpo.login, dst: cuerpo.dst });
        if (quiereJson) return json(res, 200, { ok: true, redirect: destino });
        return enviar(res, 302, '', 'text/plain', { Location: destino });
      }

      // Dispositivo que ya se registró: conectar sin llenar el formulario otra vez
      if (req.method === 'POST' && ruta === '/api/reconectar') {
        const cuerpo = await leerCuerpo(req);
        const mac = limpiar(cuerpo.mac, 17).toUpperCase();
        const r = MAC.test(mac) ? db.buscarPorMac(mac) : undefined;
        if (!r) return json(res, 404, { ok: false, errores: ['Este dispositivo no está registrado.'] });
        db.registrarConexion(r.id, mac, limpiar(cuerpo.ip, 45) || ipCliente(req));
        return json(res, 200, { ok: true, redirect: urlDeAcceso(cfg, { login: cuerpo.login, dst: cuerpo.dst }) });
      }

      // Panel de administración
      if (ruta === '/admin' || ruta === '/admin/registros.csv') {
        if (!autorizadoAdmin(cfg, req)) {
          return enviar(res, 401, 'Acceso restringido', 'text/plain; charset=utf-8', {
            'WWW-Authenticate': 'Basic realm="Panel WiFi", charset="UTF-8"',
          });
        }
        if (ruta === '/admin') return enviar(res, 200, paginaAdmin(db));
        const cols = ['id', 'creado', 'email', 'nombre', 'segundo_nombre', 'apellido', 'codigo_pais', 'telefono',
          'nacimiento', 'genero', 'acepta_sms', 'mac', 'ip'];
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
