# ReVale: MFA candidato para staging

6 de octubre de 2026. Estado: implementación de prueba, desactivada por defecto.

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

Pendientes antes de activar el candidato:

1. Ejecutar la migración y el rol únicamente en staging, provisionar la credencial
   de identidad y los secretos de Preview indicados abajo, y verificar permisos.
2. Crear cuentas sintéticas con membresías explícitas y completar las pruebas de
   los cuatro portales sobre el despliegue protegido, incluyendo enrolamiento
   real desde el navegador, consumo, reverso y liquidación.
3. Verificar desde el navegador la continuación de invitaciones de usuarios ya
   enrolados. El backend mantiene la invitación pendiente hasta recibir una
   sesión con MFA y el correo exacto; ese límite está cubierto por pruebas locales.
4. Documentar recuperación asistida cuando se pierden ambos factores y todos los
   códigos, rotación del secreto de cifrado, restauración de las nuevas tablas y
   revisión independiente. El secreto de cifrado debe recuperarse junto al respaldo.

Esto no activa MFA en las cuentas personales de administración de Vercel o Neon.
El titular debe enrolar su propio autenticador para esas cuentas.

## Cambio de infraestructura propuesto

- Proyecto Neon existente: `revale-staging` (`lively-cloud-95086101`), rama
  `br-ancient-darkness-b8aqist7`, base `neondb`.
- Aplicar `db/migrations/20261006_staging_mfa.sql` y
  `db/baseline/identity-runtime-role.sql`.
- Crear login `revale_staging_identity`, únicamente miembro de
  `revale_identity_runtime`: SELECT/INSERT/UPDATE/DELETE en las seis tablas de
  `revale_identity`; sin DDL, ownership, superusuario, membresías adicionales,
  acceso a `revale` o a `neon_auth`. El rol de negocio existente no cambia.
- Guardar su conexión y una clave aleatoria de al menos 32 bytes como secretos
  sensibles `REVALE_PREVIEW_IDENTITY_DATABASE_URL` y
  `REVALE_PREVIEW_IDENTITY_SECRET` exclusivamente en Preview del proyecto Vercel
  `revale-staging` (`prj_JDzorjuwv6YgvC2EZMdWGgxoMGmU`).
- Activar `REVALE_AUTH_PROVIDER=better-auth-mfa` solo en ese proyecto Preview y
  redesplegar el commit aprobado. Conservar los valores Neon Auth para revertir
  la configuración si se descarta el ensayo; los usuarios de ambos proveedores
  son distintos y no se vinculan automáticamente.
- No cambiar demo, live, dominios, protección SSO ni variables de otros proyectos.

## Bloqueos de esta sesión

El navegador sigue recibiendo `FUNCTION_INVOCATION_FAILED` en el SSO de Vercel,
antes de alcanzar ReVale. La revisión automática rechazó crear un enlace temporal
para la prueba porque permitiría acceso sin ese SSO, y rechazó también una consulta
de conteos de staging por considerar insuficiente su autorización. No se intentó
eludir esas denegaciones ni se cambió la protección del proyecto. Para verificar
el despliegue se necesita resolver el SSO o autorizar un acceso temporal acotado
para las pruebas y revocarlo al terminar. No se debe compartir el enlace en un PR.

## Referencias de implementación

- https://better-auth.com/docs/plugins/2fa
- https://better-auth.com/docs/adapters/postgresql
- https://vercel.com/docs/headers/request-headers
