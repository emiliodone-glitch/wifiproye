import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { crearServidor } from '../src/server.js';
import { abrirBaseDeDatos } from '../src/db.js';
import { descifrarClaveHttp, generarCredenciales, cifrarClaveUam, credencialesValidas } from '../src/routers/datto.js';

// ---------- Vectores oficiales de la documentación de CloudTrax/Datto ----------

test('descifra la clave igual que el ejemplo oficial (decode_password.php)', () => {
  const clave = descifrarClaveHttp(
    'D8A7B0E4A6122A73705C4640E86CD62EA499201D98C5F436103448C39A537B07',
    '2590CC8A3930DB222781921A8F8B88B1',
    'verysecretstring'
  );
  assert.equal(clave, '123456abcdefghijklmnopqrs');
});

test('genera usuario/clave igual que el ejemplo oficial (click-to-enter)', () => {
  const { usuario, clave } = generarCredenciales('02:ba:de:af:fe:01', 'evenmoresecretstring', 1440596666);
  assert.equal(usuario, '02-BA-DE-AF-FE-01_1440596666');
  assert.equal(clave, 'FuDiZi//mEFgleZkUW67L0ZtoaEjEgugLbi3nHCkZHw=');
});

test('acceso vencido o de otro teléfono se rechaza', () => {
  const ahora = 1_700_000_000;
  const { usuario, clave } = generarCredenciales('02:ba:de:af:fe:01', 's', ahora);
  assert.equal(credencialesValidas(usuario, clave, '02:BA:DE:AF:FE:01', 's', 300, ahora + 10), true);
  assert.equal(credencialesValidas(usuario, clave, '02:BA:DE:AF:FE:02', 's', 300, ahora + 10), false);
  assert.equal(credencialesValidas(usuario, clave, '02:BA:DE:AF:FE:01', 's', 300, ahora + 999), false);
  assert.equal(credencialesValidas(usuario, clave + 'x', '02:BA:DE:AF:FE:01', 's', 300, ahora), false);
});

// ---------- Simulación de un AP Datto ----------

const md5 = (...p) => createHash('md5').update(Buffer.concat(p.map((x) => Buffer.from(x)))).digest();

/** Lo que hace el AP: descifra la clave del /logon (UAM) y la vuelve a cifrar para el HTTP API. */
function apReCifra(hexUam, challenge, uamSecret, ra, authSecret) {
  const datos = Buffer.from(hexUam, 'hex');
  const llave = md5(Buffer.from(challenge, 'hex'), uamSecret);
  const plano = [];
  for (let i = 0; i < datos.length; i++) {
    const b = datos[i] ^ llave[i % 16];
    if (b === 0) break;
    plano.push(b);
  }
  const relleno = Buffer.alloc(Math.ceil((plano.length + 1) / 16) * 16);
  Buffer.from(plano).copy(relleno);
  const salida = Buffer.alloc(relleno.length);
  let anterior = Buffer.from(ra, 'hex');
  for (let i = 0; i < relleno.length; i += 16) {
    const k = md5(authSecret, anterior);
    for (let j = 0; j < 16; j++) salida[i + j] = relleno[i + j] ^ k[j];
    anterior = salida.subarray(i, i + 16);
  }
  return { hex: salida.toString('hex'), plano: Buffer.from(plano).toString() };
}

const cfg = {
  adminUser: 'admin', adminPass: 'x', hotspotUser: '', hotspotPass: '',
  orgName: 'Prueba', wifiName: 'WiFi', privacyUrl: '/privacidad', defaultRedirect: 'https://www.google.com', routerHosts: [],
  dattoUamSecret: 'secreto-uam', dattoAuthSecret: 'secreto-auth', firmaSecreto: 'firma',
  sesionSegundos: 7200, bajadaKbps: 5000, subidaKbps: 2000, autoConectarCompletos: true,
};
let servidor, base;
before(async () => {
  servidor = crearServidor(cfg, abrirBaseDeDatos(':memory:'));
  await new Promise((r) => servidor.listen(0, r));
  base = `http://127.0.0.1:${servidor.address().port}`;
});
after(() => servidor.close());

const MAC_GUION = '64-76-BA-8A-D3-58';
const MAC = '64:76:BA:8A:D3:58';
const parsear = (texto) => Object.fromEntries([...texto.matchAll(/"([^"]*)" "([^"]*)"/g)].map((m) => [decodeURIComponent(m[1]), decodeURIComponent(m[2])]));

async function apPregunta(params) {
  const ra = randomBytes(16).toString('hex');
  const r = parsear(await (await fetch(`${base}/datto/auth?${new URLSearchParams({ ra, ...params })}`)).text());
  // El AP verifica la firma de la respuesta
  assert.equal(r.RA, md5(r.CODE, Buffer.from(ra, 'hex'), cfg.dattoAuthSecret).toString('hex'));
  return { r, ra };
}

async function pasoCompleto(campos) {
  const challenge = randomBytes(16).toString('hex');
  const datosAp = { mac: MAC_GUION, uamip: '10.255.224.1', uamport: '8082', challenge, userurl: 'http://captive.apple.com/', called: 'AC-86-74-3B-7A-C0', ssid: 'WiFi Gratis' };
  const estado = await (await fetch(`${base}/api/estado?mac=${MAC_GUION}`)).json();
  const resp = await (await fetch(base + '/api/conectar', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...datosAp, etapa: estado.etapa, ...campos }),
  })).json();
  assert.equal(resp.ok, true, JSON.stringify(resp));

  // El navegador va al AP: http://10.255.224.1:8082/logon?username=..&password=..&redir=..
  const logon = new URL(resp.redirect);
  assert.equal(logon.origin, 'http://10.255.224.1:8082');
  assert.equal(logon.pathname, '/logon');
  assert.equal(logon.searchParams.get('redir'), 'http://captive.apple.com/');

  // El AP le pregunta a nuestro servidor si lo deja pasar
  const ra = randomBytes(16).toString('hex');
  const { hex } = apReCifra(logon.searchParams.get('password'), challenge, cfg.dattoUamSecret, ra, cfg.dattoAuthSecret);
  const q = new URLSearchParams({ type: 'login', ra, username: logon.searchParams.get('username'), password: hex, mac: MAC, node: 'AC:86:74:3B:7A:C0' });
  const r = parsear(await (await fetch(`${base}/datto/auth?${q}`)).text());
  assert.equal(r.CODE, 'ACCEPT');
  assert.equal(r.RA, md5('ACCEPT', Buffer.from(ra, 'hex'), cfg.dattoAuthSecret).toString('hex'));
  assert.equal(r.SECONDS, '7200');
  return estado;
}

test('Datto: flujo completo, un paso por conexión', async () => {
  // Teléfono nuevo: el AP pregunta "status" → REJECT → muestra el portal
  assert.equal((await apPregunta({ type: 'status', mac: MAC })).r.CODE, 'REJECT');

  assert.equal((await pasoCompleto({ email: 'ana@correo.com', acepta_terminos: true })).etapa, 'correo');
  assert.equal((await apPregunta({ type: 'status', mac: MAC })).r.CODE, 'REJECT'); // aún le faltan datos
  assert.equal((await pasoCompleto({ nombre: 'Ana', apellido: 'Pérez' })).etapa, 'nombre');
  assert.equal((await pasoCompleto({ codigo_pais: '+1', telefono: '8095551234' })).etapa, 'telefono');
  assert.equal((await pasoCompleto({ nacimiento: '1990-01-01', genero: 'femenino' })).etapa, 'detalles');

  // Perfil completo: el AP la deja entrar directo, sin portal
  const { r } = await apPregunta({ type: 'status', mac: MAC });
  assert.equal(r.CODE, 'ACCEPT');
  assert.equal(r.DOWNLOAD, '5000');
});

test('Datto: login falso o con firma inválida se rechaza', async () => {
  const ra = randomBytes(16).toString('hex');
  const { hex } = apReCifra(cifrarClaveUam('clave-inventada', 'aa'.repeat(16), cfg.dattoUamSecret), 'aa'.repeat(16), cfg.dattoUamSecret, ra, cfg.dattoAuthSecret);
  const q = new URLSearchParams({ type: 'login', ra, username: `${MAC_GUION}_${Math.floor(Date.now() / 1000)}`, password: hex, mac: MAC });
  const r = parsear(await (await fetch(`${base}/datto/auth?${q}`)).text());
  assert.equal(r.CODE, 'REJECT');
  assert.equal((await apPregunta({ type: 'acct', mac: MAC })).r.CODE, 'OK');
});
