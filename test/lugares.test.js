import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crearServidor, idLugar } from '../src/server.js';
import { abrirBaseDeDatos } from '../src/db.js';

const cfg = {
  adminUser: 'admin', adminPass: 'x', hotspotUser: 'invitado', hotspotPass: 'clave',
  orgName: 'Prueba', wifiName: 'WiFi', privacyUrl: '/privacidad', defaultRedirect: 'https://www.google.com', routerHosts: [],
  dattoUamSecret: 'u', dattoAuthSecret: 'a', firmaSecreto: 'f',
  sesionSegundos: 60, bajadaKbps: 1, subidaKbps: 1, autoConectarCompletos: true,
};
const auth = { Authorization: 'Basic ' + Buffer.from('admin:x').toString('base64') };
let servidor, base, db;

before(async () => {
  db = abrirBaseDeDatos(':memory:');
  servidor = crearServidor(cfg, db);
  await new Promise((r) => servidor.listen(0, r));
  base = `http://127.0.0.1:${servidor.address().port}`;
});
after(() => servidor.close());

const AP_CENTRO = 'F8-D9-B8-7C-4D-E0';
const AP_NORTE = 'AC-86-74-3B-7A-C0';

const conectar = (cuerpo) =>
  fetch(base + '/api/conectar', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uamip: '10.255.224.1', uamport: '8082', challenge: 'aa'.repeat(16), ...cuerpo }),
  }).then((r) => r.json());

test('normaliza el identificador de la antena', () => {
  assert.equal(idLugar('f8-d9-b8-7c-4d-e0'), 'F8:D9:B8:7C:4D:E0');
  assert.equal(idLugar('Local-Centro'), 'Local-Centro');
  assert.equal(idLugar('<script>'), null);
  assert.equal(idLugar(''), null);
});

test('cada conexión queda asociada a la antena por la que llegó', async () => {
  const mac = '11-11-11-11-11-11';
  assert.equal((await conectar({ mac, called: AP_CENTRO, etapa: 'correo', email: 'ana@x.com', acepta_terminos: true })).ok, true);
  assert.equal((await conectar({ mac, called: AP_CENTRO, etapa: 'nombre', nombre: 'Ana', apellido: 'P' })).ok, true);
  assert.equal((await conectar({ mac, called: AP_NORTE, etapa: 'telefono', telefono: '8095551234' })).ok, true);

  const lugares = db.listarLugares();
  assert.deepEqual(lugares.map((l) => l.ap).sort(), ['AC:86:74:3B:7A:C0', 'F8:D9:B8:7C:4D:E0']);
  const centro = lugares.find((l) => l.ap === 'F8:D9:B8:7C:4D:E0');
  assert.equal(centro.conexiones, 2);
  assert.equal(centro.personas, 1);
  assert.equal(centro.nombre, null);
});

test('MikroTik: el lugar llega como el nombre del router', async () => {
  await conectar({ mac: '22-22-22-22-22-22', ap: 'Local-Sur', uamip: '', etapa: 'correo', email: 'luis@x.com', acepta_terminos: true });
  assert.ok(db.listarLugares().some((l) => l.ap === 'Local-Sur'));
});

test('Datto: las entradas automáticas (perfil completo) también guardan el lugar', async () => {
  const mac = '11-11-11-11-11-11';
  await conectar({ mac, called: AP_CENTRO, etapa: 'detalles', nacimiento: '1990-01-01', genero: 'femenino' });
  const antes = db.listarLugares().find((l) => l.ap === 'AC:86:74:3B:7A:C0').conexiones;
  await fetch(`${base}/datto/auth?type=status&ra=${'0'.repeat(32)}&mac=11:11:11:11:11:11&node=AC:86:74:3B:7A:C0`);
  assert.equal(db.listarLugares().find((l) => l.ap === 'AC:86:74:3B:7A:C0').conexiones, antes + 1);
});

test('el administrador le pone nombre a cada lugar y se ve en el panel y en el CSV', async () => {
  const sinNombre = await (await fetch(base + '/admin/lugares', { headers: auth })).text();
  assert.match(sinNombre, /F8:D9:B8:7C:4D:E0/);

  const guardar = (ap, nombre, extra = {}) =>
    fetch(base + '/admin/lugares', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded', ...extra },
      body: new URLSearchParams({ ap, nombre }),
    });
  assert.equal((await guardar('F8:D9:B8:7C:4D:E0', 'Local Centro')).status, 200);
  assert.equal((await guardar('AC:86:74:3B:7A:C0', 'Local Norte')).status, 200);
  assert.equal((await guardar('00:00:00:00:00:00', 'No existe')).status, 404);

  const personas = await (await fetch(base + '/admin', { headers: auth })).text();
  assert.match(personas, /Local Centro \(3\)<br>Local Norte \(2\)/); // más visitado primero

  const csv = await (await fetch(base + '/admin/registros.csv', { headers: auth })).text();
  assert.match(csv, /Local Centro \(3\) \| Local Norte \(2\)/);
});

test('el panel de lugares pide contraseña y rechaza formularios de otros sitios', async () => {
  assert.equal((await fetch(base + '/admin/lugares')).status, 401);
  const r = await fetch(base + '/admin/lugares', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://sitio-malo.com' },
    body: new URLSearchParams({ ap: 'F8:D9:B8:7C:4D:E0', nombre: 'Hackeado' }),
  });
  assert.equal(r.status, 403);
  assert.equal(db.listarLugares().find((l) => l.ap === 'F8:D9:B8:7C:4D:E0').nombre, 'Local Centro');
});

test('una base de datos anterior (sin lugares) se actualiza sola', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wifi-'));
  const ruta = join(dir, 'vieja.db');
  const vieja = new DatabaseSync(ruta);
  vieja.exec(`CREATE TABLE conexiones (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT NOT NULL DEFAULT (datetime('now')),
    persona_id INTEGER NOT NULL, dispositivo TEXT, ip TEXT, etapa TEXT)`);
  vieja.close();
  const nueva = abrirBaseDeDatos(ruta);
  const p = nueva.obtenerOCrearPersona('x@y.com', 'hoy');
  nueva.registrarConexion(p.id, null, null, 'correo', 'Local-1');
  assert.equal(nueva.listarLugares()[0].conexiones, 1);
  nueva.cerrar();
  rmSync(dir, { recursive: true });
});
