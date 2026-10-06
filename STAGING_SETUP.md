# ReVale staging: estado y procedimiento

Fecha: 6 de octubre de 2026 UTC (5 de octubre en Ecuador).

## Recursos

- Aplicación Vercel: `revale-staging`, proyecto `prj_JDzorjuwv6YgvC2EZMdWGgxoMGmU`, equipo `team_zDuKjsH2sqTcMSoRzFV5bdQ3`.
- Vite, Node.js 22, `npm ci`, `npm run build`, salida `dist`.
- Protección de Vercel activada: `all_except_custom_domains`. No se asignaron dominios personalizados.
- Base Neon: `lively-cloud-95086101`, recurso `store_KJQIyrfQH3SO28WE`; el esquema completo ya se instaló y verificó vacío.
- Configuración creada solo para Preview: `REVALE_MODE=live`, `REVALE_SCHEMA_MODE=managed`. El modo live aplica los controles estrictos; Vercel Preview exige las conexiones específicas de pruebas.
- La aplicación no tiene todavía conexión de base ni de identidad. No se copió ningún secreto de la demo ni de live.

## Cambios de aplicación

Los siete inicializadores de esquema ya no ejecutan DDL ni semillas durante solicitudes de Preview, live o modo managed. Esos entornos requieren migraciones instaladas de antemano. Tampoco se asignan automáticamente permisos financieros a un administrador sin autorización registrada.

El proxy de autenticación exige `REVALE_AUTH_ORIGIN` en Preview/live; no reutiliza el origen canónico de la demo. La selección de conexiones rechaza reutilizar una URL conocida de live en Preview o de Preview en live, además de la protección existente contra conexiones demo.

## Acceso de ejecución propuesto, todavía no instalado

`db/baseline/runtime-role.sql` crea `revale_runtime` sin login: SELECT/INSERT/UPDATE en tablas del esquema revale y USAGE/SELECT en sus secuencias. No concede DELETE, TRUNCATE, DDL, administración de roles ni acceso al esquema neon_auth. No configura privilegios por defecto para objetos futuros: cada migración debe revisar sus permisos.

Antes de ejecutarlo, aprobar la creación del acceso y comprobar las ACL efectivas del proveedor. Luego provisionar una credencial exclusiva de staging, sin membresía en `neon_superuser` ni propiedad de esquemas/tablas, y asignarle únicamente este rol. No usar la conexión propietaria que la integración entrega por defecto como credencial de la aplicación. El script se niega a reutilizar un rol con el mismo nombre para evitar alterar una identidad preexistente sin revisión.

La prueba local con el esquema real y SET ROLE confirma lecturas, inserciones y actualizaciones; rechaza crear/alterar/eliminar tablas, borrar/truncar registros, leer tablas de identidad, cambiar el estado de secuencias y crear roles. También verifica que un superadmin sin permisos financieros explícitos no los obtiene automáticamente.

## Conexión y validación pendientes

1. Completar la verificación de correo de Neon para vincular VercelMarketplace. La consola sigue mostrando ese bloqueo; no se reenviaron correos ni se omitió el control.
2. Crear la credencial de ejecución restringida y registrar `REVALE_PREVIEW_DATABASE_URL` como secreto de Preview en el proyecto nuevo. Registrar su `REVALE_PREVIEW_AUTH_URL` independiente y el origen HTTPS canónico en `REVALE_AUTH_ORIGIN`; configurar ese origen como confiable en el Auth de staging.
3. Verificar permisos efectivos con esa credencial: sin privilegios de DDL ni acceso a `neon_auth`; sin membresías elevadas, propiedad de tablas ni grants públicos inesperados.
4. Desplegar nuevamente una versión Preview protegida, verificar salud, sesiones y rechazo cruzado frente a demo/live. No crear enlaces de bypass para inspeccionar el despliegue.
5. Cargar únicamente configuración operativa aprobada y datos sintéticos de staging. El esquema vacío no contiene plan contable, políticas de aprobación ni cuentas humanas listas para una prueba integral.

No se conectó ni desplegó una aplicación live. No se movieron dominios ni tráfico de la demo. Los previews históricos y MFA siguen pendientes.
