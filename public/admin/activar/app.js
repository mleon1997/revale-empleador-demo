(() => {
  'use strict';
  const root=document.getElementById('activation-root'),token=location.hash.slice(1);
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const roles={superadmin:'Administración',finance:'Finanzas',ops:'Operaciones',support:'Soporte'};
  let invitation,mode='create',busy=false;
  async function api(action,body={}){
    const r=await fetch('/api/admin-auth?action='+action,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,...body})});
    const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error||'No pudimos conectar. Intenta nuevamente.');return data;
  }
  function shell(content){root.innerHTML=`<article class="activation-card"><section class="activation-story"><img class="activation-logo" src="/empleados/revale-logo-green.webp" alt="ReVale"><div><span class="eyebrow">REVALE · ADMINISTRACIÓN</span><h1>Cada acceso<br>cuenta.</h1><p>Tu espacio para gestionar ReVale.<br>Con una cuenta propia y un acceso protegido.</p></div><div class="activation-star" aria-hidden="true">✳</div><footer>Una cuenta por persona.<br>Cada decisión, con su responsable.</footer></section><section class="activation-content">${content}</section></article>`;}
  function render(){
    const creating=mode==='create';
    shell(`<span class="eyebrow">ENTORNO DE PRUEBAS</span><h2>Hola, ${esc(invitation.first_name)}.</h2><p>${creating?'Elige tu contraseña. Después conectarás tu autenticador para activar el acceso.':'Ingresa con tu cuenta y completa la verificación de seguridad.'}</p><div class="activation-person"><b>${esc(invitation.email)}</b><span>${esc(roles[invitation.role]||invitation.role)} · Acceso personal</span></div><form id="activate-form"><label class="form-field">${creating?'Crea tu contraseña':'Tu contraseña'}<input id="password" class="input" type="password" minlength="${creating?12:8}" maxlength="128" autocomplete="${creating?'new-password':'current-password'}" required></label>${creating?'<label class="form-field">Confirma tu contraseña<input id="confirm" class="input" type="password" minlength="12" maxlength="128" autocomplete="new-password" required></label><p class="activation-footnote">Usa al menos 12 caracteres. Una frase fácil de recordar funciona muy bien.</p>':''}<div id="error" class="activation-error hidden" role="alert"></div><button class="btn green full" type="submit">Continuar con mi autenticador</button></form><button class="text-btn activation-switch" id="switch">${creating?'Ya tengo una cuenta':'Crear una cuenta nueva'}</button><p class="activation-footnote">Tu acceso se habilitará al completar la verificación. Guarda los códigos de recuperación en un lugar seguro.</p>`);
    document.getElementById('switch').onclick=()=>{if(!busy){mode=creating?'existing':'create';render();}};
    document.getElementById('activate-form').onsubmit=async event=>{
      event.preventDefault();if(busy)return;
      const password=document.getElementById('password').value,error=document.getElementById('error'),button=event.currentTarget.querySelector('[type=submit]');error.classList.add('hidden');
      if(creating&&password!==document.getElementById('confirm').value){error.textContent='Las contraseñas deben coincidir.';error.classList.remove('hidden');return;}
      busy=true;button.disabled=true;button.textContent='Preparando tu verificación…';
      try{const result=await api('activate',{password,mode});location.replace(result.next);}
      catch(e){error.textContent=e.message;error.classList.remove('hidden');button.disabled=false;button.textContent='Continuar con mi autenticador';busy=false;}
    };
  }
  (async()=>{try{
    if(new URLSearchParams(location.search).get('mfa')==='complete'){await api('activate',{mode:'session'});history.replaceState(null,'',location.pathname);location.replace('/admin/');return;}
    invitation=(await api('invitation')).invitation;render();
  }catch(e){shell(`<span class="eyebrow">ACCESO PERSONAL</span><h2>Te ayudamos a entrar.</h2><p>${esc(e.message)}</p><a class="btn green full" href="/admin/">Ir al inicio de sesión</a>`);}})();
})();
