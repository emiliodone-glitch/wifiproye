import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function abrirBaseDeDatos(ruta) {
  if (ruta !== ':memory:') mkdirSync(dirname(ruta), { recursive: true });
  const db = new DatabaseSync(ruta);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS registros (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      creado         TEXT NOT NULL DEFAULT (datetime('now')),
      email          TEXT NOT NULL,
      nombre         TEXT NOT NULL,
      segundo_nombre TEXT,
      apellido       TEXT NOT NULL,
      codigo_pais    TEXT NOT NULL,
      telefono       TEXT NOT NULL,
      nacimiento     TEXT,
      genero         TEXT,
      acepta_sms     INTEGER NOT NULL DEFAULT 0,
      mac            TEXT,
      ip             TEXT,
      user_agent     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_registros_mac ON registros(mac);
    CREATE TABLE IF NOT EXISTS conexiones (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha       TEXT NOT NULL DEFAULT (datetime('now')),
      registro_id INTEGER NOT NULL REFERENCES registros(id),
      mac         TEXT,
      ip          TEXT
    );
  `);

  const insertarRegistro = db.prepare(`
    INSERT INTO registros (email, nombre, segundo_nombre, apellido, codigo_pais, telefono,
                           nacimiento, genero, acepta_sms, mac, ip, user_agent)
    VALUES (:email, :nombre, :segundo_nombre, :apellido, :codigo_pais, :telefono,
            :nacimiento, :genero, :acepta_sms, :mac, :ip, :user_agent)
  `);
  const insertarConexion = db.prepare(
    'INSERT INTO conexiones (registro_id, mac, ip) VALUES (?, ?, ?)'
  );
  const buscarPorMac = db.prepare(
    'SELECT id, nombre FROM registros WHERE mac = ? ORDER BY id DESC LIMIT 1'
  );

  return {
    guardarRegistro(datos) {
      const { lastInsertRowid } = insertarRegistro.run(datos);
      insertarConexion.run(lastInsertRowid, datos.mac, datos.ip);
      return Number(lastInsertRowid);
    },
    buscarPorMac(mac) {
      return mac ? buscarPorMac.get(mac) : undefined;
    },
    registrarConexion(registroId, mac, ip) {
      insertarConexion.run(registroId, mac, ip);
    },
    listar(limite = 500) {
      return db.prepare(`
        SELECT r.*, (SELECT COUNT(*) FROM conexiones c WHERE c.registro_id = r.id) AS visitas
        FROM registros r ORDER BY r.id DESC LIMIT ?
      `).all(limite);
    },
    todos() {
      return db.prepare('SELECT * FROM registros ORDER BY id').all();
    },
    resumen() {
      return db.prepare(`
        SELECT (SELECT COUNT(*) FROM registros) AS registros,
               (SELECT COUNT(*) FROM conexiones) AS conexiones,
               (SELECT COUNT(*) FROM registros WHERE date(creado) = date('now')) AS hoy
      `).get();
    },
    cerrar() {
      db.close();
    },
  };
}
