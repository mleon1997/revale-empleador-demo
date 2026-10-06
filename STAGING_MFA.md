# ReVale: MFA candidato para staging

6 de octubre de 2026. Estado: activo exclusivamente en `revale-staging` / Preview.
Permanece desactivado por defecto en el código y no se ha promovido a producción.

## Por qué hace falta

La configuración administrada de Neon Auth de staging no expone el segundo factor.
El candidato usa Better Auth 1.7.7 con su plugin TOTP en el backend de ReVale, con
seis tablas en un esquema independiente `revale_identity`. No migra usuarios ni
contraseñas de Neon Auth. Solo puede activarse en Preview con `REVALE_MODE=live`.
Demo y la futura aplicación live conservan su autenticación actual.

## Comportamiento implementado

- Contraseña seguida de código TOTP. MFA obligatorio para todos los portales del
  candidato; una sesión solo con contraseña no obtiene un principal de negocio.
- Alta mediante QR generado en ReVale, confirmación del código y diez códigos
  de recuperación cifrados y de un solo uso. No se usan servicios externos de QR.
- Prueba de MFA asociada a la sesión concreta. Una sesión previa sin MFA sigue
  bloqueada aunque el usuario complete el alta desde otra sesión.
- Desafío de cinco minutos, bloqueo de cuenta tras cinco fallos durante quince
  minutos y límites persistentes en PostgreSQL. No se habilitan dispositivos de
  confianza ni desactivación pública del segundo factor.
- Cookies Secure, HttpOnly y SameSite=Lax; sesiones de hasta ocho horas y sin
  caché de sesiones en cookies. No se devuelven tokens de sesión al JavaScript.
- Rutas públicas limitadas a estado, alta TOTP, verificación, recuperación,
  regeneración de recuperación con contraseña y MFA, y cierre de sesión. El
  router completo de Better Auth no está expuesto al público.

## Verificación y alcance

Las pruebas locales verifican alta, sesión, bloqueo sin MFA, sesión antigua,
recuperación consumida, desafío consumido, expiración, aislamiento de cookies,
protección de origen, configuración cerrada y permisos del rol de identidad.
Las pruebas con múltiples conexiones PostgreSQL se ejecutan en CI.
La migración se genera con la versión fijada y se compara contra ella en las pruebas.

Activación autorizada y aplicada:

- Se instalaron las seis tablas y el rol restringido; los permisos efectivos
  permiten CRUD solo en identidad, sin DDL, TRUNCATE ni acceso a negocio/Neon Auth.
- Se guardaron dos variables sensibles y la bandera del proveedor solo en Preview.
- El despliegue inicial expuso `ERR_REQUIRE_ESM`: Vercel transformaba los imports
  de Better Auth en `require()`. Se corrigió declarando `type: module` y convirtiendo
  la configuración PostCSS a ESM. El commit verificado es
  `ffe1a2d8c8a840c8634ae0145d80cc40a112cf90`.
- Se corrigió además el agotamiento del límite público de `/get-session` por
  comprobaciones internas: estas usan `auth.api.getSession`. El endpoint público
  conserva su límite y las verificaciones de contraseña/factor siguen pasando por
  el limitador. Una prueba reproduce la recuperación con ese bucket agotado.
- Despliegue: `dpl_6sjmLTH2jyNBXsw4JaeD8UTfcfrs`, estado READY.
- CI: https://github.com/mleon1997/revale-empleador-demo/actions/runs/37499858099
  — 84 pruebas aprobadas, ninguna omitida; incluye concurrencia PostgreSQL real.
  La restauración sintética de 44 tablas de negocio pasó; no acredita restauración
  del nuevo esquema de identidad ni un respaldo real.

Prueba del despliegue completada el 6 de octubre de 2026, 12:03 America/Guayaquil:

- Empleados, empresas, comercios y administración: contraseña sola bloqueada,
  TOTP válido aceptado, sesión del rol correcto y rechazo de los otros tres roles.
- Recuperación aceptada después de contraseña, sesión verificada y rechazo de
  reutilización del mismo código en un desafío nuevo, en los cuatro portales.
- Logout invalida la sesión y las mutaciones de otro origen se rechazan.
- El QR generado se decodificó durante la inscripción sintética y coincidió con
  el factor cifrado. Factores y códigos de recuperación no se guardan en texto claro.
- Se revocaron los enlaces temporales; el último se cerró antes de sus 15 minutos.
  Se revocó también un enlace anterior de mayor duración encontrado al inspeccionar
  el alias. No se modificó la configuración SSO del proyecto.
- Se desactivaron las cuatro membresías y entidades sintéticas. Se eliminaron sus
  identidades, sesiones, cuentas, factores y desafíos: todos esos conteos quedaron
  en cero. Las filas de negocio ficticias se conservaron inactivas.
- Evidencia sin secretos: `db/baseline/staging-mfa-verification-20261006.json`.

Actualización posterior: `STAGING_FLOW_20261006.md` documenta el recorrido financiero
con MFA ya verificado por HTTP y la restauración sintética conjunta de negocio e
identidad. Incluye un defecto encontrado en la restricción de estados de liquidación
y su migración aplicada únicamente a staging. La suite subió a 86 pruebas.

Pendientes antes de considerar una promoción fuera de staging:

1. Enrolamiento humano con autenticador y continuación de invitaciones en navegador.
   La pantalla del desafío se inspeccionó visualmente; las pruebas automatizadas
   del despliegue ejercitan HTTP y QR, no una aplicación de autenticación humana.
2. Recepción y asignación de fondos empresariales, invitaciones y enrolamiento humano
   por UI. El recorrido posterior de consumo, reverso y liquidación ya pasó en staging.
3. Recuperación real de las seis tablas de identidad y de la clave desplegada desde
   su custodia independiente; rotación y recuperación asistida aprobadas y ensayadas.
   La restauración sintética conjunta y revocación de sesiones restauradas ya pasaron.
4. Revisión independiente de seguridad y enrolamiento de cuentas humanas nominativas.

Esto no activa MFA en las cuentas personales de administración de Vercel o Neon.
El titular debe enrolar su propio autenticador para esas cuentas.

## Infraestructura aplicada

- Proyecto Neon existente: `revale-staging` (`lively-cloud-95086101`), rama
  `br-ancient-darkness-b8aqist7`, base `neondb`.
- Se aplicaron `db/migrations/20261006_staging_mfa.sql` y
  `db/baseline/identity-runtime-role.sql`.
- Se creó el login `revale_staging_identity`, únicamente miembro de
  `revale_identity_runtime`: SELECT/INSERT/UPDATE/DELETE en las seis tablas de
  `revale_identity`; sin DDL, ownership, superusuario, membresías adicionales,
  acceso a `revale` o a `neon_auth`. El rol de negocio existente no cambia.
- Se guardaron su conexión y una clave aleatoria de 48 bytes como secretos
  sensibles `REVALE_PREVIEW_IDENTITY_DATABASE_URL` y
  `REVALE_PREVIEW_IDENTITY_SECRET` exclusivamente en Preview del proyecto Vercel
  `revale-staging` (`prj_JDzorjuwv6YgvC2EZMdWGgxoMGmU`).
- Se activó `REVALE_AUTH_PROVIDER=better-auth-mfa` solo en ese proyecto Preview. Conservar los valores Neon Auth para revertir
  la configuración si se descarta el ensayo; los usuarios de ambos proveedores
  son distintos y no se vinculan automáticamente.
- Demo, live, dominios y configuración SSO de otros proyectos no forman parte del cambio.

## Recuperación operativa antes de usuarios reales

- Un código de recuperación reemplaza TOTP una vez, después de la contraseña.
- Perder contraseña, autenticador y códigos requiere un procedimiento asistido con
  verificación independiente del titular, revocación de sesiones y nuevo enrolamiento.
  Ese flujo administrativo todavía no está implementado ni validado para producción.
- El secreto de identidad cifra factores y recuperación: cambiarlo directamente
  impide descifrar los registros existentes. No rotarlo como una contraseña de base
  de datos. Se debe ensayar una migración compatible o re-enrolamiento con sesiones
  revocadas y acceso controlado antes de introducir usuarios reales.
- Una restauración debe recuperar tablas y la versión correspondiente de la clave;
  probar descifrado y MFA con una cuenta sintética en un destino aislado, y revocar
  sesiones/desafíos restaurados antes de reabrir accesos. No guardar claves en Git.
- Revertir el ensayo requiere redesplegar la versión anterior y quitar la bandera
  del proveedor en Preview. Los usuarios Neon Auth y Better Auth son distintos;
  no asumir continuidad de sesiones ni vincular cuentas automáticamente.

## Referencias de implementación

- https://better-auth.com/docs/plugins/2fa
- https://better-auth.com/docs/adapters/postgresql
- https://vercel.com/docs/headers/request-headers
