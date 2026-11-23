import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { crearServidor, urlDeAcceso } from '../src/server.js';
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

const router = { mac: 'aa:bb:cc:dd:ee:ff', login: 'http://10.5.50.1/login', dst: 'http://example.com/' };
const auth = { Authorization: 'Basic ' + Buffer.from('admin:secreto').toString('base64') };

const estado = async (mac = router.mac) => (await fetch(`${base}/api/estado?mac=${encodeURIComponent(mac)}`)).json();
const conectar = async (cuerpo) => {
  const r = await fetch(base + '/api/conectar', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...router, ...cuerpo }),
  });
  return { status: r.status, ...(await r.json()) };
};

test('el portal carga con el nombre de la red y da una cookie', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /WiFi Prueba/);
  assert.match(r.headers.get('set-cookie'), /wp_disp=[a-f0-9]{32}/);
});

test('1ª conexión: solo pide el correo', async () => {
  const e = await estado();
  assert.equal(e.etapa, 'correo');
  assert.equal(e.nuevo, true);

  const malo = await conectar({ etapa: 'correo', email: 'no-es-correo' });
  assert.equal(malo.status, 400);
  assert.equal(malo.errores.length, 2); // correo inválido + términos

  const r = await conectar({ etapa: 'correo', email: 'Ana@Ejemplo.com', acepta_terminos: true });
  assert.equal(r.ok, true);
  const u = new URL(r.redirect);
  assert.equal(u.host, '10.5.50.1');
  assert.equal(u.searchParams.get('username'), 'invitado');
  assert.equal(u.searchParams.get('password'), 'clave123');
  assert.equal(u.searchParams.get('dst'), 'http://example.com/');
});

test('2ª conexión: dice que ya está registrado y pide nombre y apellido', async () => {
  const e = await estado();
  assert.equal(e.etapa, 'nombre');
  assert.equal(e.paso, 2);
  assert.match(e.titulo, /Ya estás registrado/);
  assert.equal((await conectar({ etapa: 'nombre', nombre: 'Ana' })).status, 400); // falta apellido
  assert.equal((await conectar({ etapa: 'nombre', nombre: 'Ana', apellido: 'Pérez' })).ok, true);
});

test('3ª conexión: saluda por el nombre y pide teléfono', async () => {
  const e = await estado();
  assert.equal(e.etapa, 'telefono');
  assert.match(e.titulo, /Ana/);
  assert.equal((await conectar({ etapa: 'telefono', codigo_pais: '+1', telefono: '809-555-1234', acepta_sms: true })).ok, true);
});

test('4ª conexión: nacimiento y género; después entra sin formulario', async () => {
  assert.equal((await estado()).etapa, 'detalles');
  assert.equal((await conectar({ etapa: 'detalles', nacimiento: '1990-05-01', genero: 'femenino' })).ok, true);
  const e = await estado();
  assert.equal(e.etapa, null);
  assert.equal(e.nombre, 'Ana');
  assert.equal((await conectar({ etapa: null })).ok, true);

  const [p] = db.todos();
  assert.equal(p.email, 'ana@ejemplo.com');
  assert.equal(p.telefono, '8095551234');
  assert.equal(p.acepta_sms, 1);
  assert.equal(p.genero, 'femenino');
  assert.equal(p.visitas, 5);
});

test('si la página quedó vieja, el servidor indica el paso correcto', async () => {
  const r = await conectar({ etapa: 'nombre', nombre: 'Otro', apellido: 'Nombre' });
  assert.equal(r.status, 409);
  assert.equal(r.estado.etapa, null);
});

test('teléfono nuevo con el mismo correo continúa donde iba, sin borrar datos', async () => {
  const otro = { mac: '11:22:33:44:55:66' };
  assert.equal((await estado(otro.mac)).etapa, 'correo');
  const r = await conectar({ ...otro, etapa: 'correo', email: 'ana@ejemplo.com', acepta_terminos: true });
  assert.equal(r.ok, true);
  assert.equal(r.estado.etapa, null); // ya tenía todo
  assert.equal(db.todos()[0].nombre, 'Ana');
});

test('sin MAC (modo prueba) se reconoce por cookie', async () => {
  const cookie = (await fetch(base + '/')).headers.get('set-cookie').split(';')[0];
  const post = (b) => fetch(base + '/api/conectar', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(b),
  }).then((r) => r.json());
  assert.equal((await post({ etapa: 'correo', email: 'luis@correo.com', acepta_terminos: true })).ok, true);
  const e = await (await fetch(base + '/api/estado', { headers: { Cookie: cookie } })).json();
  assert.equal(e.etapa, 'nombre');
});

test('nunca envía la clave del hotspot a un servidor público', () => {
  assert.equal(urlDeAcceso(cfg, { login: 'https://atacante.com/robar', dst: 'https://x.com' }), 'https://x.com');
});

test('el panel exige contraseña, muestra el progreso y exporta CSV', async () => {
  assert.equal((await fetch(base + '/admin')).status, 401);
  const html = await (await fetch(base + '/admin', { headers: auth })).text();
  assert.match(html, /ana@ejemplo.com/);
  assert.match(html, /4\/4/);
  assert.match(html, /1\/4/); // luis solo dio el correo
  const csv = await (await fetch(base + '/admin/registros.csv', { headers: auth })).text();
  assert.match(csv, /ana@ejemplo.com/);
});

test('el CSV neutraliza fórmulas de Excel', async () => {
  const mac = { mac: '22:22:22:22:22:22' };
  await conectar({ ...mac, etapa: 'correo', email: 'x@y.com', acepta_terminos: true });
  await conectar({ ...mac, etapa: 'nombre', nombre: '=HYPERLINK("x")', apellido: 'Z' });
  const csv = await (await fetch(base + '/admin/registros.csv', { headers: auth })).text();
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
});
