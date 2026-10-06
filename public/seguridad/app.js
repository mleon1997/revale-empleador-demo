(() => {
  'use strict';
  const root=document.getElementById('security-root');
  const destinations={employee:'/empleados/',employer:'/empresas/',merchant:'/comercios/',admin:'/admin/'};
  const requested=new URLSearchParams(location.search).get('portal');
  const portal=Object.hasOwn(destinations,requested)?requested:'employee';
  const home=destinations[portal];
  const activationToken=location.hash.slice(1);
  const activationPaths={employee:'/activar/',employer:'/empresas/activar/',admin:'/admin/activar/'};
  const resume=new URLSearchParams(location.search).get('activation')==='1'&&/^[A-Za-z0-9_-]{43}$/.test(activationToken)&&Object.hasOwn(activationPaths,portal)
    ?activationPaths[portal]+'?mfa=complete#'+activationToken:home;
  const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let recovery=false;
  async function api(action,body){
    const response=await fetch('/api/identity?action='+action,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify({...body,portal})});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||'No pudimos completar la verificación.');
    return data;
  }
  function error(message){const target=document.getElementById('error');target.textContent=message;target.classList.remove('hidden');}
  function shell(title,copy,form){root.innerHTML=`<div class="symbol" aria-hidden="true">✳</div><h1>${title}</h1><p>${copy}</p>${form}<div id="error" role="alert" class="error hidden"></div><button class="text" id="restart">Volver al inicio de sesión</button>`;document.getElementById('restart').onclick=async()=>{try{await api('logout',{});location.replace(home);}catch(e){error(e.message);}};}
  function bind(work){const form=document.getElementById('security-form');form.onsubmit=async e=>{e.preventDefault();const button=form.querySelector('button[type=submit]');button.disabled=true;document.getElementById('error').classList.add('hidden');try{await work();}catch(err){error(err.message);button.disabled=false;}};}
  function verifyForm(enrolling=false){
    return `<form id="security-form"><label for="code">${recovery?'Código de recuperación':'Código de tu autenticador'}</label><input id="code" ${recovery?'':'class="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6"'} autocomplete="one-time-code" required>${enrolling?'<label class="check"><input type="checkbox" required>Guardé mis códigos de recuperación en un lugar seguro.</label>':''}<button type="submit">Verificar y entrar</button></form>`;
  }
  function bindVerification(){bind(async()=>{await api(recovery?'recovery':'totp',{code:document.getElementById('code').value.trim()});root.replaceChildren();location.replace(resume);});}
  function challenge(){
    shell(recovery?'Recupera tu acceso.':'Un paso más.<br>Tu acceso, protegido.',recovery?'Ingresa uno de los códigos que guardaste al configurar tu autenticador. Cada código sirve una sola vez.':'Abre tu aplicación de autenticación e ingresa el código de seis dígitos de ReVale.',verifyForm()+`<button class="secondary" id="switch">${recovery?'Usar mi autenticador':'Usar un código de recuperación'}</button>`);
    document.getElementById('switch').onclick=()=>{recovery=!recovery;challenge();};bindVerification();
  }
  function enroll(){
    shell('Dale otra llave<br>a tu acceso.','Protege tu cuenta con una aplicación como Google Authenticator, Microsoft Authenticator o 1Password. Primero confirma tu contraseña.',`<form id="security-form"><label for="password">Tu contraseña de ReVale</label><input id="password" type="password" autocomplete="current-password" required><button type="submit">Configurar autenticador</button></form>`);
    bind(async()=>{const data=await api('enable',{password:document.getElementById('password').value});recovery=false;
      shell('Conecta tu autenticador.','Escanea el QR y guarda los códigos de recuperación. Después ingresa el código del autenticador para terminar.',`<img class="qr" src="${esc(data.qr)}" alt="Código QR personal para configurar el autenticador"><p class="hint">Códigos de recuperación · guárdalos antes de continuar.</p><div class="codes">${data.backupCodes.map(c=>`<span>${esc(c)}</span>`).join('')}</div>${verifyForm(true)}`);bindVerification();
    });
  }
  (async()=>{try{const status=await api('status');if(status.verified){location.replace(resume);return;}if(status.authenticated&&!status.enrolled)enroll();else challenge();}catch(e){shell('No pudimos abrir<br>la verificación.','Vuelve a iniciar sesión para continuar.','');error(e.message);}})();
})();
