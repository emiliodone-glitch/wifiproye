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

    -- Cada antena/router que ha enviado gente al portal, con el nombre del lugar.
    -- Se crean solas la primera vez que llega alguien; el nombre se pone en /admin/lugares.
    CREATE TABLE IF NOT EXISTS lugares (
      ap           TEXT PRIMARY KEY,
      nombre       TEXT,
      primer_visto TEXT NOT NULL DEFAULT (datetime('now')),
      ultimo_visto TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Bases de datos creadas antes de existir los lugares: agregar la columna.
  if (!db.prepare('PRAGMA table_info(conexiones)').all().some((c) => c.name === 'ap')) {
    db.exec('ALTER TABLE conexiones ADD COLUMN ap TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_conexiones_ap ON conexiones(ap)');

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
    conexion: db.prepare('INSERT INTO conexiones (persona_id, dispositivo, ip, etapa, ap) VALUES (?, ?, ?, ?, ?)'),
    verLugar: db.prepare(`
      INSERT INTO lugares (ap) VALUES (?)
      ON CONFLICT(ap) DO UPDATE SET ultimo_visto = datetime('now')`),
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

    registrarConexion(personaId, dispositivo, ip, etapa, ap) {
      if (dispositivo) q.tocarDispositivo.run(dispositivo);
      if (ap) q.verLugar.run(ap);
      q.conexion.run(personaId, dispositivo || null, ip || null, etapa || null, ap || null);
    },

    // ---------- Lugares ----------

    listarLugares() {
      return db.prepare(`
        SELECT l.*,
          (SELECT COUNT(*) FROM conexiones c WHERE c.ap = l.ap) AS conexiones,
          (SELECT COUNT(DISTINCT persona_id) FROM conexiones c WHERE c.ap = l.ap) AS personas,
          (SELECT COUNT(*) FROM conexiones c WHERE c.ap = l.ap AND date(c.fecha) = date('now')) AS hoy
        FROM lugares l ORDER BY l.nombre IS NULL DESC, l.nombre, l.ap`).all();
    },

    nombrarLugar(ap, nombre) {
      return db.prepare("UPDATE lugares SET nombre = ? WHERE ap = ?").run(nombre || null, ap).changes > 0;
    },

    /** { persona_id: [{ ap, nombre, veces }, ...] } ordenado de más a menos visitas. */
    lugaresPorPersona() {
      const filas = db.prepare(`
        SELECT c.persona_id, c.ap, l.nombre, COUNT(*) AS veces
        FROM conexiones c LEFT JOIN lugares l ON l.ap = c.ap
        WHERE c.ap IS NOT NULL
        GROUP BY c.persona_id, c.ap ORDER BY veces DESC`).all();
      const mapa = {};
      for (const f of filas) (mapa[f.persona_id] ||= []).push({ ap: f.ap, nombre: f.nombre, veces: f.veces });
      return mapa;
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
