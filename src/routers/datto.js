/**
 * Integración con puntos de acceso DATTO NETWORKING (AP440 y demás, administrados en
 * Datto Network Manager). Usan el mismo protocolo que Open Mesh / CloudTrax:
 *
 *  A) "Splash page (UAM) – Hosted remotely": el AP manda al teléfono a NUESTRO portal con
 *     ?res=notyet&uamip=..&uamport=..&mac=..&called=..&ssid=..&userurl=..&challenge=..
 *     Cuando la persona termina el paso, nuestro servidor la manda de vuelta al AP:
 *     http://<uamip>:<uamport>/logon?username=..&password=<cifrado con challenge + secreto UAM>
 *
 *  B) "Authentication: HTTP API": el AP le pregunta a NUESTRO servidor (/datto/auth) si
 *     deja pasar a ese usuario. Respondemos ACCEPT/REJECT firmado con el secreto HTTP.
 *
 * Usuario y clave NO son de la persona: los genera el portal (MAC + hora, firmados con
 * HMAC) solo para probarle al AP que ese teléfono pasó por el formulario.
 *
 * Referencia: https://github.com/cloudtrax/docs/tree/master/captive_portal
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const md5 = (...partes) => createHash('md5').update(Buffer.concat(partes.map((p) => Buffer.from(p)))).digest();
const HEX = /^[0-9a-f]+$/i;

/** ¿La petición al portal viene de un AP Datto? */
export const esDatto = (p) => !!(p && p.uamip && p.uamport && p.challenge);

/** Cifra la clave para /logon (lado portal → AP), con el "challenge" y el secreto UAM. */
export function cifrarClaveUam(plana, challengeHex, secreto, extra = randomBytes(Math.floor(Math.random() * 17))) {
  if (!challengeHex || challengeHex.length % 2 || !HEX.test(challengeHex)) return null;
  const chall = Buffer.from(challengeHex, 'hex');
  const llave = secreto ? md5(chall, secreto) : chall;
  const texto = Buffer.concat([Buffer.from(plana), Buffer.from([0])]); // como cadena de C, termina en \0
  const cifrado = Buffer.alloc(texto.length);
  for (let i = 0; i < texto.length; i++) cifrado[i] = texto[i] ^ llave[i % llave.length];
  return Buffer.concat([cifrado, extra]).toString('hex');
}

/** Descifra la clave que manda el AP en type=login (lado AP → servidor HTTP API). */
export function descifrarClaveHttp(cifradoHex, raHex, secreto) {
  if (!cifradoHex || cifradoHex.length % 32 || !HEX.test(cifradoHex)) return null;
  if (!raHex || raHex.length !== 32 || !HEX.test(raHex)) return null;
  const datos = Buffer.from(cifradoHex, 'hex');
  const salida = Buffer.alloc(datos.length);
  let anterior = Buffer.from(raHex, 'hex');
  for (let i = 0; i < datos.length; i += 16) {
    const llave = md5(secreto, anterior);
    for (let j = 0; j < 16; j++) salida[i + j] = llave[j] ^ datos[i + j];
    anterior = datos.subarray(i, i + 16);
  }
  return salida.toString('latin1').replace(/\0+$/, '');
}

/** "RA" de respuesta: md5(CODE + RA original en binario + secreto). */
export const raRespuesta = (codigo, raHex, secreto) => md5(codigo, Buffer.from(raHex, 'hex'), secreto).toString('hex');

// ---------- Credenciales de un solo uso ----------

const macGuiones = (mac) => String(mac || '').toUpperCase().replace(/:/g, '-');

export function generarCredenciales(mac, firma, ahora = Math.floor(Date.now() / 1000)) {
  const usuario = `${macGuiones(mac)}_${ahora}`;
  const clave = createHmac('sha256', firma).update(usuario).digest('base64');
  return { usuario, clave };
}

export function credencialesValidas(usuario, clave, mac, firma, vigenciaSeg = 300, ahora = Math.floor(Date.now() / 1000)) {
  const m = /^((?:[0-9A-F]{2}-){5}[0-9A-F]{2})_(\d+)$/.exec(usuario || '');
  if (!m || m[1] !== macGuiones(mac)) return false;
  const t = Number(m[2]);
  if (t > ahora + 30 || ahora - t > vigenciaSeg) return false;
  const esperada = Buffer.from(createHmac('sha256', firma).update(usuario).digest('base64'));
  const recibida = Buffer.from(String(clave || ''));
  return esperada.length === recibida.length && timingSafeEqual(esperada, recibida);
}

/** URL a la que se manda el navegador para que el AP abra el internet. */
export function urlLogon(cfg, p) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(p.uamip) || !/^\d{1,5}$/.test(String(p.uamport))) return null;
  const { usuario, clave } = generarCredenciales(p.mac, cfg.firmaSecreto);
  const cifrada = cifrarClaveUam(clave, p.challenge, cfg.dattoUamSecret);
  if (!cifrada) return null;
  let url = `http://${p.uamip}:${p.uamport}/logon?username=${encodeURIComponent(usuario)}&password=${cifrada}`;
  if (/^https?:\/\//i.test(p.userurl || '')) url += `&redir=${encodeURIComponent(p.userurl)}`;
  return url;
}

// ---------- Servidor de autenticación (HTTP API) ----------

const formatear = (dic) =>
  Object.entries(dic).map(([k, v]) => `"${encodeURIComponent(k)}" "${encodeURIComponent(v)}"`).join('\n') + '\n';

/**
 * Responde a las consultas del AP:
 *   type=status → ¿ya conoces este teléfono? (al conectarse o cuando vence la sesión)
 *   type=login  → la persona terminó el paso en el portal, ¿lo dejo pasar?
 *   type=acct / logout → reportes de uso
 *
 * @param estaCompleto(mac) → true si la persona ya dio todos sus datos. A esas personas
 *        se les deja entrar directo, sin ver el portal (si cfg.autoConectarCompletos).
 */
export function responderAuth(cfg, q, { estaCompleto, alConectar } = {}) {
  const ra = typeof q.ra === 'string' && q.ra.length === 32 && HEX.test(q.ra) ? q.ra : null;
  const secreto = cfg.dattoAuthSecret;
  const aceptar = {
    CODE: 'ACCEPT',
    SECONDS: String(cfg.sesionSegundos),
    DOWNLOAD: String(cfg.bajadaKbps),
    UPLOAD: String(cfg.subidaKbps),
  };
  let r = { CODE: 'REJECT', BLOCKED_MSG: 'Completa el registro en el portal' };

  if (!ra || !secreto) {
    r.BLOCKED_MSG = 'Solicitud inválida';
  } else if (q.type === 'status') {
    if (cfg.autoConectarCompletos && estaCompleto?.(q.mac)) r = aceptar;
  } else if (q.type === 'login') {
    const clave = descifrarClaveHttp(q.password, ra, secreto);
    if (clave != null && credencialesValidas(q.username, clave, q.mac, cfg.firmaSecreto)) {
      r = aceptar;
      alConectar?.(q.mac);
    } else {
      r.BLOCKED_MSG = 'Acceso no válido, vuelve a intentarlo';
    }
  } else if (q.type === 'acct' || q.type === 'logout') {
    r = { CODE: 'OK' };
  }

  r.RA = ra ? raRespuesta(r.CODE, ra, secreto || '') : '0'.repeat(32);
  return formatear(r);
}
