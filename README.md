# wifiproye — Portal cautivo propio

Cuando alguien se conecta al Wi-Fi, el teléfono abre solo una página donde la persona deja sus datos.
Al enviar el formulario, el router le abre el internet. Los datos quedan guardados en nuestro servidor
y se pueden ver y descargar en Excel desde `/admin`.

---

## ¿Cómo se vincula el router con nuestra página?

El router **no** guarda la página: solo la "presenta". El truco tiene 4 pasos:

```
 Teléfono                     Router (MikroTik Hotspot)                Nuestro servidor
    │  1. Se conecta a la red abierta  │                                       │
    │─────────────────────────────────>│                                       │
    │  2. El teléfono prueba internet  │                                       │
    │     (captive.apple.com, etc.)    │                                       │
    │─────────────────────────────────>│ Bloquea y responde con login.html     │
    │<─────────────────────────────────│ → "ve a https://portal.tudominio.com  │
    │                                  │    ?mac=..&login=..&dst=.."           │
    │  3. Se abre la ventanita "Captive Wi-Fi" con NUESTRO formulario          │
    │─────────────────────────────────────────────────────────────────────────>│
    │                                  │   (permitido por el "walled garden")  │
    │  4. Envía datos ─────────────────────────────────────────────────────────>│ guarda en la BD
    │<─────────────────────────────────────────────────── redirige al router   │
    │     http://10.5.50.1/login?username=invitado&password=***&dst=...        │
    │─────────────────────────────────>│ Usuario correcto → abre el internet   │
    │<─────────────── internet ────────│ para ESA MAC                          │
```

1. **Red abierta**: el router emite un Wi-Fi sin contraseña con el servicio *Hotspot* activado.
2. **Detección automática**: iPhone y Android, al conectarse, intentan abrir una página de prueba. Como
   el router la bloquea, el teléfono entiende que hay un portal y abre la ventanita "Captive Wi-Fi".
3. **Redirección**: el router muestra su `login.html`. Nosotros lo reemplazamos por uno
   (`router/mikrotik/login.html`) que manda a nuestro servidor con la MAC del teléfono y la dirección del router.
   El *walled garden* (jardín amurallado) permite entrar a nuestro servidor aunque la persona aún no tenga internet.
4. **Autorización**: cuando la persona envía el formulario, nuestro servidor guarda los datos y manda el
   navegador de vuelta al router con un usuario/clave de hotspot. El router lo valida y le abre internet
   a ese dispositivo. Con `mac-cookie`, ese teléfono vuelve a entrar solo durante 7 días.

> Este proyecto viene listo para **MikroTik** (el más usado para esto y económico). Para UniFi, TP-Link
> Omada u OpenWrt el servidor es el mismo; solo cambia el paso 4 (cómo se le avisa al router).

---

## Qué hay en el proyecto

| Archivo | Para qué |
|---|---|
| `src/server.js` | El servidor: formulario, registro, reconexión, panel `/admin` y descarga CSV |
| `src/db.js` | Base de datos SQLite (un solo archivo, `data/registros.db`) |
| `public/portal.html`, `estilos.css`, `portal.js` | La página que ve la gente. Colores en `estilos.css` (`--color`) |
| `public/privacidad.html` | Plantilla de política de privacidad (**hay que completarla**) |
| `public/logo.png` | Pon aquí el logo (opcional; también sirve `.svg`, `.jpg`, `.webp`) |
| `router/mikrotik/login.html` | Va dentro del router: manda a la gente a nuestro portal |
| `router/mikrotik/configurar.rsc` | Script para configurar el hotspot del MikroTik |

No necesita instalar paquetes: solo **Node.js 22.13 o más nuevo**.

---

## Paso a paso

### 1. Probar en tu computadora

```bash
cp .env.example .env      # y edita las claves
npm start                 # abre http://localhost:3000
npm test                  # pruebas automáticas
```

Para simular que vienes del router: `http://localhost:3000/?mac=AA:BB:CC:DD:EE:FF&login=http://10.5.50.1/login`

### 2. Publicar el servidor en internet

El portal tiene que estar en una dirección con **HTTPS**, por ejemplo `https://portal.tudominio.com`.
Opciones: un VPS (DigitalOcean, Hetzner, Contabo; ~5 USD/mes) con [Caddy](https://caddyserver.com) delante
para el HTTPS automático, o un servicio como Railway/Render con disco persistente.

```bash
# en el VPS
git clone <este repo> && cd wifiproye
cp .env.example .env && nano .env     # claves reales
npm start                             # mejor con pm2 o systemd para que no se apague
```

Variables importantes en `.env`:
- `ADMIN_USER` / `ADMIN_PASS`: acceso al panel `/admin`.
- `HOTSPOT_USER` / `HOTSPOT_PASS`: **deben ser iguales** a los del router.
- `ORG_NAME`, `WIFI_NAME`: textos de la página.

### 3. Configurar el MikroTik

1. Conéctate con **WinBox** (o la web del router).
2. Crea la red Wi-Fi abierta (sin contraseña) con el nombre que quieras.
3. `IP → Hotspot → Hotspot Setup` sobre esa interfaz/bridge. Acepta los valores por defecto
   (crea el servidor `hotspot1` y el perfil `hsprof1`). Deja el DNS name vacío.
4. Abre `router/mikrotik/configurar.rsc`, cambia `portal` y `clave`, y pégalo en `New Terminal`.
5. En `router/mikrotik/login.html` cambia `https://portal.tudominio.com` por tu dirección real (2 lugares).
6. En WinBox → `Files`, arrastra ese `login.html` a la carpeta `hotspot` (o `flash/hotspot`),
   reemplazando el que está.
7. Conéctate con un teléfono a la red: debe abrirse el formulario solo.

### 4. Ver los registros

`https://portal.tudominio.com/admin` → usuario y clave de `.env`. Botón **Descargar Excel (CSV)**.

---

## Datos personales — importante

Se recogen correo, teléfono, fecha de nacimiento y género. En República Dominicana aplica la
**Ley 172-13**. Antes de usarlo con el público:
- Completen `public/privacidad.html` (quién es responsable, para qué se usan, cómo pedir que se borren).
- El permiso para mensajes SMS es opcional y separado de los términos (ya está así en el formulario).
- Guarden bien la clave del panel y hagan copias de `data/registros.db`.
