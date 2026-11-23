/**
 * REGISTRO PROGRESIVO
 *
 * Cada vez que la persona se conecta, se le pide SOLO la siguiente etapa que le falta.
 *   1ª conexión → correo
 *   2ª conexión → nombre y apellido
 *   3ª conexión → teléfono
 *   4ª conexión → fecha de nacimiento y género
 *   Después     → entra con un toque (o automático)
 *
 * Para cambiar el orden, quitar o agregar pasos, edita esta lista.
 * (Si agregas un campo nuevo, también hay que agregarlo en VALIDADORES, en la tabla
 *  "personas" de db.js y en public/portal.html.)
 */
export const ETAPAS = [
  {
    id: 'correo',
    titulo: 'Escribe tu correo para conectarte',
    campos: ['email', 'acepta_terminos'],
    obligatorios: ['email', 'acepta_terminos'],
  },
  {
    id: 'nombre',
    titulo: '¡Hola de nuevo! Ya estás registrado. Para seguir conectándote, dinos tu nombre.',
    campos: ['nombre', 'segundo_nombre', 'apellido'],
    obligatorios: ['nombre', 'apellido'],
  },
  {
    id: 'telefono',
    titulo: '¡Hola, {nombre}! Para seguir conectándote, agrega tu número de teléfono.',
    campos: ['codigo_pais', 'telefono', 'acepta_sms'],
    obligatorios: ['codigo_pais', 'telefono'],
  },
  {
    id: 'detalles',
    titulo: '¡Hola, {nombre}! Último paso: tu fecha de nacimiento y género.',
    campos: ['nacimiento', 'genero'],
    obligatorios: ['nacimiento', 'genero'],
  },
];

const limpiar = (v, max = 100) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const marcado = (v) => v === true || v === 'on' || v === '1' || v === 1;

/** Cada validador devuelve { valor } o { error }. "valor" vacío = no lo llenó. */
export const VALIDADORES = {
  email(v) {
    const s = limpiar(v, 254).toLowerCase();
    if (!s) return { valor: null };
    return /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(s) ? { valor: s } : { error: 'Escribe un correo electrónico válido.' };
  },
  acepta_terminos(v) {
    // Se guarda la fecha en que aceptó.
    return { valor: marcado(v) ? new Date().toISOString() : null, columna: 'terminos_aceptados_en' };
  },
  nombre: (v) => ({ valor: limpiar(v) || null }),
  segundo_nombre: (v) => ({ valor: limpiar(v) || null }),
  apellido: (v) => ({ valor: limpiar(v) || null }),
  codigo_pais(v) {
    const s = limpiar(v, 5) || '+1';
    return /^\+\d{1,4}$/.test(s) ? { valor: s } : { error: 'Código de país inválido.' };
  },
  telefono(v) {
    const s = limpiar(v, 30).replace(/\D/g, '');
    if (!s) return { valor: null };
    return s.length >= 7 && s.length <= 15 ? { valor: s } : { error: 'Escribe un número de teléfono válido.' };
  },
  acepta_sms: (v) => ({ valor: marcado(v) ? 1 : 0 }),
  nacimiento(v) {
    const s = limpiar(v, 10);
    if (!s) return { valor: null };
    const f = new Date(s + 'T00:00:00Z');
    const ok = /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(f) && f <= new Date() && f.getUTCFullYear() >= 1900;
    return ok ? { valor: s } : { error: 'Fecha de nacimiento inválida.' };
  },
  genero: (v) => ({ valor: ['femenino', 'masculino', 'otro'].includes(v) ? v : null }),
};

const MENSAJE_FALTA = {
  email: 'Escribe tu correo electrónico.',
  acepta_terminos: 'Debes aceptar los términos y la política de privacidad.',
  nombre: 'Escribe tu nombre.',
  apellido: 'Escribe tu apellido.',
  telefono: 'Escribe tu número de teléfono.',
  nacimiento: 'Escribe tu fecha de nacimiento.',
  genero: 'Elige una opción de género.',
};

const columnaDe = (campo) => (campo === 'acepta_terminos' ? 'terminos_aceptados_en' : campo);

/** Primera etapa que a esta persona le falta completar (o null si ya tiene todo). */
export function etapaPendiente(persona) {
  if (!persona) return ETAPAS[0];
  return ETAPAS.find((e) => e.obligatorios.some((c) => persona[columnaDe(c)] == null || persona[columnaDe(c)] === '')) || null;
}

/** Valida SOLO los campos de la etapa indicada. Devuelve { datos: {columna: valor}, errores }. */
export function validarEtapa(etapa, entrada) {
  const datos = {};
  const errores = [];
  for (const campo of etapa.campos) {
    const r = VALIDADORES[campo](entrada[campo]);
    if (r.error) errores.push(r.error);
    else if (r.valor == null && etapa.obligatorios.includes(campo)) errores.push(MENSAJE_FALTA[campo] || `Falta ${campo}.`);
    else datos[columnaDe(campo)] = r.valor;
  }
  return { datos, errores };
}

export function tituloDe(etapa, persona) {
  return etapa.titulo.replace('{nombre}', persona?.nombre || '');
}
