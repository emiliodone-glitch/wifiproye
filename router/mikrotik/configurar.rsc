# =====================================================================
#  Configuración del Hotspot MikroTik para el portal propio (RouterOS v7)
#
#  ANTES de correr este script:
#   1. Hacer el asistente:  IP > Hotspot > "Hotspot Setup"  (o en terminal:
#      /ip hotspot setup) sobre la interfaz/bridge del Wi-Fi de invitados.
#      Eso crea el servidor "hotspot1" y el perfil "hsprof1".
#   2. Cambiar los 3 valores de abajo.
#   3. Pegar el script en New Terminal, o subirlo y ejecutar:
#      /import configurar.rsc
# =====================================================================

# ---- CAMBIAR ESTOS VALORES ----
:local portal "portal.tudominio.com"
:local clave "cambia-esta-clave-tambien"
:local perfilHotspot "hsprof1"
# -------------------------------

# Perfil de los invitados: cuántos pueden usar el mismo usuario, tiempo y velocidad.
/ip hotspot user profile
:if ([:len [find name="invitados"]] = 0) do={ add name="invitados" }
set [find name="invitados"] shared-users=unlimited session-timeout=1d idle-timeout=30m keepalive-timeout=5m rate-limit="5M/5M"

# Usuario único que usa el portal para abrir el internet a cada dispositivo
# (debe coincidir con HOTSPOT_USER / HOTSPOT_PASS del servidor).
/ip hotspot user
:if ([:len [find name="invitado"]] = 0) do={ add name="invitado" password=$clave profile="invitados" } \
  else={ set [find name="invitado"] password=$clave profile="invitados" }

# Login por HTTP-PAP (lo usa el portal) + cookie para que un teléfono que ya
# se registró entre solo durante 7 días sin ver el formulario.
/ip hotspot profile
set [find name=$perfilHotspot] login-by=http-pap,mac-cookie http-cookie-lifetime=7d

# "Jardín amurallado": sitios a los que se puede entrar ANTES de registrarse.
# Sin esto, el teléfono no podría abrir nuestro portal.
/ip hotspot walled-garden
:if ([:len [find dst-host=$portal]] = 0) do={ add dst-host=$portal comment="Portal de registro" }
/ip hotspot walled-garden ip
:if ([:len [find dst-host=$portal]] = 0) do={ add dst-host=$portal action=accept comment="Portal de registro (HTTPS)" }

:put "Listo. Ahora sube router/mikrotik/login.html a la carpeta hotspot del router."
