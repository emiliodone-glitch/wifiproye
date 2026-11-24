#!/usr/bin/env bash
# Crea el archivo .env con claves seguras y muestra lo que hay que poner en Datto.
# Uso:  ./configurar.sh
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then
  echo "Ya existe un archivo .env. Bórralo o renómbralo si quieres crear uno nuevo."
  exit 1
fi

clave() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

preguntar() { # preguntar "Texto" "valor por defecto"
  local r
  read -r -p "$1 [$2]: " r || true
  echo "${r:-$2}"
}

DOMINIO=${DOMINIO:-$(preguntar "Dominio del portal (ej.: portal.miempresa.com)" "portal.ejemplo.com")}
ORG_NAME=${ORG_NAME:-$(preguntar "Nombre de la organización" "Mi Organización")}
WIFI_NAME=${WIFI_NAME:-$(preguntar "Nombre de la red Wi-Fi" "WiFi Gratis")}
ADMIN_USER=${ADMIN_USER:-admin}
ADMIN_PASS=${ADMIN_PASS:-$(clave | cut -c1-16)}
UAM=$(clave); AUTH=$(clave); FIRMA=$(clave)

cat > .env <<CONF
DOMINIO=$DOMINIO
PORT=3000
ADMIN_USER=$ADMIN_USER
ADMIN_PASS=$ADMIN_PASS
ORG_NAME=$ORG_NAME
WIFI_NAME=$WIFI_NAME
PIE_TEXTO=Aporte Secretaría de Operaciones
PRIVACY_URL=/privacidad
DEFAULT_REDIRECT=https://www.google.com
DATTO_UAM_SECRET=$UAM
DATTO_AUTH_SECRET=$AUTH
FIRMA_SECRETO=$FIRMA
SESION_MINUTOS=120
AUTO_CONECTAR_COMPLETOS=si
BAJADA_KBPS=5000
SUBIDA_KBPS=2000
DB_PATH=./data/registros.db
CONF
chmod 600 .env
mkdir -p data

cat <<RESUMEN

Listo. Archivo .env creado.

Panel de registros:  https://$DOMINIO/admin
  Usuario:  $ADMIN_USER
  Clave:    $ADMIN_PASS

Datos para Datto Network Manager (SSID de invitados > Captive Portal):
  Splash page type ........ Hosted remotely
  Splash page URL ......... https://$DOMINIO/
  Splash page secret ...... $UAM
  Authentication .......... HTTP
  Authentication URL ...... http://$DOMINIO/datto/auth
  Authentication secret ... $AUTH
  Block duration .......... 10 minutos o más
  Walled garden ........... $DOMINIO

Siguiente paso:  docker compose up -d
RESUMEN
