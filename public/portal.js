(function () {
  var form = document.getElementById('formulario');
  var params = new URLSearchParams(location.search);

  // 1. Copiar al formulario los datos que mandó el router (MAC, IP, URL de login, destino).
  ['mac', 'ip', 'login', 'dst'].forEach(function (k) {
    if (params.get(k)) form.elements[k].value = params.get(k);
  });

  // Si el router avisó de un error de login, mostrarlo.
  if (params.get('error')) mostrarErrores(['No se pudo completar la conexión. Intenta de nuevo.']);

  // Máxima fecha de nacimiento = hoy.
  form.elements.nacimiento.max = new Date().toISOString().slice(0, 10);

  function mostrarErrores(lista) {
    var caja = document.getElementById('errores');
    caja.innerHTML = '';
    lista.forEach(function (t) {
      var p = document.createElement('p');
      p.textContent = t;
      caja.appendChild(p);
    });
    caja.hidden = lista.length === 0;
    if (lista.length) caja.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function datosRouter() {
    return { mac: form.elements.mac.value, ip: form.elements.ip.value, login: form.elements.login.value, dst: form.elements.dst.value };
  }

  function enviarJson(url, cuerpo) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(cuerpo),
    }).then(function (r) { return r.json(); });
  }

  // 2. ¿Ya se registró antes este dispositivo? Ofrecer conectarse con un toque.
  var mac = form.elements.mac.value;
  if (mac) {
    fetch('/api/estado?mac=' + encodeURIComponent(mac))
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (!r.registrado) return;
        document.getElementById('regreso-nombre').textContent = r.nombre;
        document.getElementById('regreso').hidden = false;
        form.hidden = true;
      })
      .catch(function () {});
  }

  document.getElementById('boton-otro').addEventListener('click', function () {
    document.getElementById('regreso').hidden = true;
    form.hidden = false;
  });

  document.getElementById('boton-reconectar').addEventListener('click', function (e) {
    e.target.disabled = true;
    e.target.textContent = 'Conectando…';
    enviarJson('/api/reconectar', datosRouter())
      .then(function (r) {
        if (r.ok) location.href = r.redirect;
        else { document.getElementById('boton-otro').click(); mostrarErrores(r.errores); }
      })
      .catch(function () { e.target.disabled = false; e.target.textContent = 'Conectarme'; });
  });

  // 3. Enviar el registro y, si todo sale bien, ir al router para que abra el internet.
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var errores = [];
    if (!form.elements.email.checkValidity() || !form.elements.email.value) errores.push('Escribe un correo electrónico válido.');
    if (!form.elements.nombre.value.trim()) errores.push('Escribe tu nombre.');
    if (!form.elements.apellido.value.trim()) errores.push('Escribe tu apellido.');
    if (form.elements.telefono.value.replace(/\D/g, '').length < 7) errores.push('Escribe un número de teléfono válido.');
    if (!form.elements.acepta_terminos.checked) errores.push('Debes aceptar los términos y la política de privacidad.');
    mostrarErrores(errores);
    if (errores.length) return;

    var boton = document.getElementById('boton-enviar');
    boton.disabled = true;
    boton.textContent = 'Conectando…';

    var cuerpo = {};
    new FormData(form).forEach(function (v, k) { cuerpo[k] = v; });
    cuerpo.acepta_sms = form.elements.acepta_sms.checked;
    cuerpo.acepta_terminos = form.elements.acepta_terminos.checked;

    enviarJson('/api/registro', cuerpo)
      .then(function (r) {
        if (r.ok) { location.href = r.redirect; return; }
        mostrarErrores(r.errores || ['No se pudo registrar. Intenta de nuevo.']);
        boton.disabled = false;
        boton.textContent = 'Aceptar y conectar';
      })
      .catch(function () {
        mostrarErrores(['No hay conexión con el servidor. Intenta de nuevo.']);
        boton.disabled = false;
        boton.textContent = 'Aceptar y conectar';
      });
  });
})();
