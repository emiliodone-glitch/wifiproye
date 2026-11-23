(function () {
  var form = document.getElementById('formulario');
  var params = new URLSearchParams(location.search);
  var boton = document.getElementById('boton-enviar');
  var estadoActual = null;

  // 1. Guardar los datos que mandó el router.
  //    MikroTik: mac, ip, login, dst
  //    Datto:    mac, uamip, uamport, challenge, userurl, called, ssid, nasid (+ res)
  var CAMPOS_ROUTER = ['mac', 'ip', 'login', 'dst', 'ap', 'uamip', 'uamport', 'challenge', 'userurl', 'called', 'ssid', 'nasid'];
  var router = {};
  CAMPOS_ROUTER.forEach(function (k) {
    if (params.get(k)) router[k] = params.get(k);
  });
  var res = params.get('res'); // solo Datto: notyet | success | failed | logoff
  form.elements.nacimiento.max = new Date().toISOString().slice(0, 10);

  function $(id) { return document.getElementById(id); }

  function mostrarErrores(lista) {
    var caja = $('errores');
    caja.innerHTML = '';
    lista.forEach(function (t) {
      var p = document.createElement('p');
      p.textContent = t;
      caja.appendChild(p);
    });
    caja.hidden = lista.length === 0;
  }

  function datosRouter() {
    var d = {};
    for (var k in router) d[k] = router[k];
    return d;
  }

  function post(cuerpo) {
    return fetch('/api/conectar', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(cuerpo),
    }).then(function (r) { return r.json(); });
  }

  // 2. Mostrar SOLO el paso que le toca a este dispositivo.
  function mostrar(estado) {
    estadoActual = estado;
    $('cargando').hidden = true;

    if (!estado.etapa) {
      // Perfil completo: conectar automáticamente.
      form.hidden = true;
      $('completo').hidden = false;
      $('completo-nombre').textContent = estado.nombre || '';
      conectarCompleto();
      return;
    }

    form.hidden = false;
    $('completo').hidden = true;
    form.elements.etapa.value = estado.etapa;
    $('titulo').textContent = estado.titulo;

    var etapas = form.querySelectorAll('.etapa');
    for (var i = 0; i < etapas.length; i++) {
      var activa = etapas[i].getAttribute('data-etapa') === estado.etapa;
      etapas[i].hidden = !activa;
      etapas[i].disabled = !activa; // los pasos ocultos no se envían
    }

    // Puntitos de progreso: ● ● ○ ○
    var pasos = $('pasos');
    pasos.innerHTML = '';
    for (var n = 1; n <= estado.total; n++) {
      var punto = document.createElement('i');
      if (n < estado.paso) punto.className = 'hecho';
      if (n === estado.paso) punto.className = 'actual';
      pasos.appendChild(punto);
    }
    pasos.hidden = estado.nuevo; // al primer contacto no asustamos con "4 pasos"

    var primero = form.querySelector('.etapa:not([hidden]) input:not([type=hidden])');
    if (primero && !estado.nuevo) primero.focus();
  }

  function conectarCompleto() {
    var b = $('boton-completo');
    b.disabled = true;
    b.textContent = 'Conectando…';
    var cuerpo = datosRouter();
    cuerpo.etapa = null;
    post(cuerpo)
      .then(function (r) {
        if (r.ok) location.href = r.redirect;
        else if (r.estado) mostrar(r.estado);
      })
      .catch(function () { b.disabled = false; b.textContent = 'Conectarme'; });
  }
  $('boton-completo').addEventListener('click', conectarCompleto);

  function cargarEstado() {
    var mac = router.mac;
    fetch('/api/estado' + (mac ? '?mac=' + encodeURIComponent(mac) : ''), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(mostrar)
      .catch(function () {
        $('cargando').textContent = 'No hay conexión con el servidor. Cierra y vuelve a abrir esta ventana.';
      });
  }

  if (res === 'success' || res === 'logoff') {
    // El AP Datto avisa que ya está conectado (o que cerró la sesión).
    $('cargando').hidden = true;
    $('aviso').hidden = false;
    $('aviso-texto').textContent = res === 'success'
      ? '¡Listo! Ya tienes internet. Puedes cerrar esta ventana.'
      : 'Tu sesión terminó. Vuelve a conectarte a la red para entrar de nuevo.';
    return;
  }
  if (params.get('error') || res === 'failed') mostrarErrores(['No se pudo completar la conexión. Intenta de nuevo.']);
  cargarEstado();

  // 3. Enviar el paso y, si todo sale bien, ir al router para que abra el internet.
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var cuerpo = datosRouter();
    cuerpo.etapa = form.elements.etapa.value;
    new FormData(form).forEach(function (v, k) { if (!(k in cuerpo)) cuerpo[k] = v; });
    ['acepta_terminos', 'acepta_sms'].forEach(function (k) {
      var c = form.elements[k];
      if (!c.disabled) cuerpo[k] = c.checked;
    });

    mostrarErrores([]);
    boton.disabled = true;
    boton.textContent = 'Conectando…';

    post(cuerpo)
      .then(function (r) {
        if (r.ok) { location.href = r.redirect; return; }
        if (r.estado) mostrar(r.estado);
        mostrarErrores(r.errores || ['No se pudo registrar. Intenta de nuevo.']);
        boton.disabled = false;
        boton.textContent = 'Conectarme';
      })
      .catch(function () {
        mostrarErrores(['No hay conexión con el servidor. Intenta de nuevo.']);
        boton.disabled = false;
        boton.textContent = 'Conectarme';
      });
  });
})();
