import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Columnas de "personas" que se pueden llenar desde el formulario (lista blanca).
export const COLUMNAS_PERSONA = [
  'email', 'terminos_aceptados_en', 'nombre', 'segundo_nombre', 'apellido',
  'codigo_pais', 'telefono', 'acepta_sms', 'nacimiento', 'genero',
];

export function abrirBaseDeDatos(ruta) {
  if (ruta !== ':memory:') mkdirSync(dirname(ruta), { recursive: true });
  const db = new DatabaseSync(ruta);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    -- Una fila por persona. Se va completando en cada conexión.
    CREATE TABLE IF NOT EXISTS personas (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      creado                TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado           TEXT NOT NULL DEFAULT (datetime('now')),
      email                 TEXT NOT NULL UNIQUE,
      terminos_aceptados_en TEXT,
      nombre                TEXT,
      segundo_nombre        TEXT,
      apellido              TEXT,
      codigo_pais           TEXT,
      telefono              TEXT,
      acepta_sms            INTEGER,
      nacimiento            TEXT,
      genero                TEXT
    );

    -- Los teléfonos/computadoras de cada persona (por MAC o, si no hay, por cookie).
    CREATE TABLE IF NOT EXISTS dispositivos (
      clave        TEXT PRIMARY KEY,
      persona_id   INTEGER NOT NULL REFERENCES personas(id),
      primer_visto TEXT NOT NULL DEFAULT (datetime('now')),
      ultimo_visto TEXT NOT NULL DEFAULT (datetime('now')),
      user_agent   TEXT
    );

    -- Historial: cada vez que alguien se conecta y qué paso completó.
    CREATE TABLE IF NOT EXISTS conexiones (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha      TEXT NOT NULL DEFAULT (datetime('now')),
      persona_id INTEGER NOT NULL REFERENCES personas(id),
      dispositivo TEXT,
      ip         TEXT,
      etapa      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_conexiones_persona ON conexiones(persona_id);
  `);

  const q = {
    personaPorDispositivo: db.prepare(`
      SELECT p.* FROM dispositivos d JOIN personas p ON p.id = d.persona_id WHERE d.clave = ?`),
    personaPorEmail: db.prepare('SELECT * FROM personas WHERE email = ?'),
    personaPorId: db.prepare('SELECT * FROM personas WHERE id = ?'),
    crearPersona: db.prepare('INSERT INTO personas (email, terminos_aceptados_en) VALUES (?, ?)'),
    vincular: db.prepare(`
      INSERT INTO dispositivos (clave, persona_id, user_agent) VALUES (?, ?, ?)
      ON CONFLICT(clave) DO UPDATE SET persona_id = excluded.persona_id,
        ultimo_visto = datetime('now'), user_agent = excluded.user_agent`),
    tocarDispositivo: db.prepare("UPDATE dispositivos SET ultimo_visto = datetime('now') WHERE clave = ?"),
    conexion: db.prepare('INSERT INTO conexiones (persona_id, dispositivo, ip, etapa) VALUES (?, ?, ?, ?)'),
  };

  return {
    personaPorDispositivo: (clave) => (clave ? q.personaPorDispositivo.get(clave) : undefined),
    personaPorEmail: (email) => q.personaPorEmail.get(email),

    /** Busca a la persona por correo o la crea. */
    obtenerOCrearPersona(email, terminos) {
      const existente = q.personaPorEmail.get(email);
      if (existente) return existente;
      const { lastInsertRowid } = q.crearPersona.run(email, terminos);
      return q.personaPorId.get(lastInsertRowid);
    },

    vincularDispositivo(clave, personaId, userAgent) {
      if (clave) q.vincular.run(clave, personaId, userAgent || null);
    },

    /**
     * Completa datos de la persona. Nunca borra ni reemplaza un dato que ya existe
     * (así nadie puede cambiar los datos de otro solo conociendo su MAC).
     */
    completarPersona(personaId, datos) {
      const cols = Object.keys(datos).filter((c) => COLUMNAS_PERSONA.includes(c) && datos[c] != null);
      if (!cols.length) return q.personaPorId.get(personaId);
      const sets = cols.map((c) => `${c} = COALESCE(${c}, :${c})`).join(', ');
      const params = Object.fromEntries(cols.map((c) => [c, datos[c]]));
      db.prepare(`UPDATE personas SET ${sets}, actualizado = datetime('now') WHERE id = :id`).run({ ...params, id: personaId });
      return q.personaPorId.get(personaId);
    },

    registrarConexion(personaId, dispositivo, ip, etapa) {
      if (dispositivo) q.tocarDispositivo.run(dispositivo);
      q.conexion.run(personaId, dispositivo || null, ip || null, etapa || null);
    },

    listar(limite = 500) {
      return db.prepare(`
        SELECT p.*,
          (SELECT COUNT(*) FROM conexiones c WHERE c.persona_id = p.id) AS visitas,
          (SELECT COUNT(*) FROM dispositivos d WHERE d.persona_id = p.id) AS dispositivos,
          (SELECT MAX(fecha) FROM conexiones c WHERE c.persona_id = p.id) AS ultima_visita
        FROM personas p ORDER BY p.actualizado DESC LIMIT ?`).all(limite);
    },
    todos() {
      return db.prepare(`
        SELECT p.*, (SELECT COUNT(*) FROM conexiones c WHERE c.persona_id = p.id) AS visitas
        FROM personas p ORDER BY p.id`).all();
    },
    resumen() {
      return db.prepare(`
        SELECT (SELECT COUNT(*) FROM personas) AS personas,
               (SELECT COUNT(*) FROM conexiones) AS conexiones,
               (SELECT COUNT(*) FROM conexiones WHERE date(fecha) = date('now')) AS hoy`).get();
    },
    cerrar: () => db.close(),
  };
}
