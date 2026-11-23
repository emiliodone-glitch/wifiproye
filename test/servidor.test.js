import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { crearServidor, urlDeAcceso, validarRegistro } from '../src/server.js';
import { abrirBaseDeDatos } from '../src/db.js';

const cfg = {
  adminUser: 'admin', adminPass: 'secreto', hotspotUser: 'invitado', hotspotPass: 'clave123',
  orgName: 'Prueba', wifiName: 'WiFi Prueba', privacyUrl: '/privacidad',
  defaultRedirect: 'https://www.google.com', routerHosts: [],
};
let servidor, base, db;

before(async () => {
  db = abrirBaseDeDatos(':memory:');
  servidor = crearServidor(cfg, db);
  await new Promise((r) => servidor.listen(0, r));
  base = `http://127.0.0.1:${servidor.address().port}`;
});
after(() => servidor.close());

const valido = {
  email: 'Ana@Ejemplo.com', nombre: 'Ana', apellido: 'Pérez', codigo_pais: '+1',
  telefono: '809-555-1234', acepta_terminos: true, acepta_sms: true,
  mac: 'aa:bb:cc:dd:ee:ff', login: 'http://10.5.50.1/login', dst: 'http://example.com/',
};

test('el portal carga con el nombre de la red', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /WiFi Prueba/);
});

test('rechaza datos incompletos', () => {
  const { errores } = validarRegistro({ email: 'malo', nombre: '', telefono: '1' });
  assert.ok(errores.length >= 4);
});

test('registro guarda datos y manda al router con usuario y clave', async () => {
  const r = await fetch(base + '/api/registro', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(valido),
  });
  const j = await r.json();
  assert.equal(j.ok, true);
  const u = new URL(j.redirect);
  assert.equal(u.host, '10.5.50.1');
  assert.equal(u.searchParams.get('username'), 'invitado');
  assert.equal(u.searchParams.get('password'), 'clave123');
  assert.equal(u.searchParams.get('dst'), 'http://example.com/');
  const [fila] = db.todos();
  assert.equal(fila.email, 'ana@ejemplo.com');
  assert.equal(fila.telefono, '8095551234');
  assert.equal(fila.mac, 'AA:BB:CC:DD:EE:FF');
  assert.equal(fila.acepta_sms, 1);
});

test('un dispositivo ya registrado puede reconectarse', async () => {
  const e = await (await fetch(base + '/api/estado?mac=AA:BB:CC:DD:EE:FF')).json();
  assert.deepEqual(e, { registrado: true, nombre: 'Ana' });
  const r = await fetch(base + '/api/reconectar', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mac: 'aa:bb:cc:dd:ee:ff', login: 'http://10.5.50.1/login' }),
  });
  assert.equal((await r.json()).ok, true);
});

test('nunca envía la clave del hotspot a un servidor público', () => {
  const destino = urlDeAcceso(cfg, { login: 'https://atacante.com/robar', dst: 'https://x.com' });
  assert.equal(destino, 'https://x.com');
});

test('el panel exige contraseña y exporta CSV', async () => {
  assert.equal((await fetch(base + '/admin')).status, 401);
  const auth = { Authorization: 'Basic ' + Buffer.from('admin:secreto').toString('base64') };
  const html = await (await fetch(base + '/admin', { headers: auth })).text();
  assert.match(html, /ana@ejemplo.com/);
  const csv = await (await fetch(base + '/admin/registros.csv', { headers: auth })).text();
  assert.match(csv, /ana@ejemplo.com/);
});

test('el CSV neutraliza fórmulas de Excel', async () => {
  await fetch(base + '/api/registro', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...valido, mac: '', nombre: '=HYPERLINK("x")' }),
  });
  const auth = { Authorization: 'Basic ' + Buffer.from('admin:secreto').toString('base64') };
  const csv = await (await fetch(base + '/admin/registros.csv', { headers: auth })).text();
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
});
