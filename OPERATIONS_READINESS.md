# ReVale: preparación operativa

Fecha: 6 de octubre de 2026. Este cambio endurece el entorno demo; no constituye una aprobación para operar con fondos reales.

## Alcance de esta entrega

- Retiro de consultas legacy de personas y saldos sin autenticación (HTTP 410).
- Sesión obligatoria para consultar y confirmar un QR; alcance por comercio y sucursal en estado, reversos y conciliación de facturas.
- Confirmaciones y reversos bajo transacción Serializable, bloqueo del consumo y reintentos limitados por conflictos de concurrencia. Un reintento no debe volver a mover saldo.
- Elegibilidad, saldo y reglas de consumo comprobados dentro de la transacción. Límites diarios calculados en hora de Ecuador.
- Débito, movimiento de ledger y evento contable pendiente persistidos de forma atómica. Si falla el evento, se revierte todo el débito. La contabilización posterior puede recuperarse mediante la conciliación de eventos pendientes del Admin.
- Tokens QR criptográficos; rechazo de mutaciones desde otros orígenes; eliminación de creación, reactivación y elevación automática de administradores demo durante el login.
- Correos reales sin verificación no pueden reclamar accesos antiguos aún no vinculados a una identidad autenticada.

## Entornos

El proyecto actual debe mantener `REVALE_MODE=demo`. Los usuarios demo ya existentes conservan su login; las rutas de autenticación ya no crean usuarios demo automáticamente.

| Entorno | Configuración exigida |
| --- | --- |
| Demo | `REVALE_MODE=demo`, conexión demo e identidad demo existentes |
| Preview | `REVALE_PREVIEW_DATABASE_URL` y `REVALE_PREVIEW_AUTH_URL` distintas de demo |
| Real | `REVALE_MODE=live`, `REVALE_LIVE_DATABASE_URL` y `REVALE_LIVE_AUTH_URL` distintas de demo; identidades demo rechazadas |

No se han provisionado aquí las bases ni proveedores de identidad de preview/real. El código rechaza usar las conexiones demo heredadas en preview. Sus pantallas estáticas pueden cargar, pero sus APIs no estarán operativas hasta configurar esos recursos. Una URL distinta no prueba por sí sola aislamiento físico: comprobar proyecto, base, credenciales y permisos antes del piloto. No copiar datos personales reales hacia pruebas.

## Verificación reproducible

`npm run test:employer`, `npm run test:security` y `npm run build`.

La suite de seguridad usa PGlite localmente y omite cuatro casos de concurrencia cuando no hay servidor PostgreSQL. El workflow `Security and transaction integrity` crea PostgreSQL 16 desechable, con conexiones independientes y datos sintéticos, y ejecuta también esos cuatro casos: doce confirmaciones del mismo QR, dos empleados compitiendo por un QR, dos consumos que excederían el límite diario y doce reversos simultáneos. Nunca apuntar la suite a una base de la aplicación: elimina su esquema de prueba. La conexión nativa está restringida a localhost y nombres `revale_test_*`.

Antes de publicar, exigir resultado verde del workflow sobre el commit exacto. Después verificar HTTP 410 en las consultas retiradas, HTTP 401 sin sesión en los flujos protegidos, HTTP 403 para origen ajeno y login/sesión de los portales existentes. No probar movimientos de dinero en el entorno publicado.

## Condiciones pendientes antes de fondos reales

| Área | Evidencia necesaria |
| --- | --- |
| Recuperación | Retención de backups confirmada; restauración ejecutada en una base aislada; tiempos y pérdida máxima de datos medidos y aceptados |
| Acceso privilegiado | MFA de administradores y proveedores, inventario de permisos y revocación probada |
| Vigilancia | Alertas de errores, desfases de conciliación, eventos contables pendientes y disponibilidad; responsable y procedimiento de incidente |
| Dinero de extremo a extremo | Revisar carreras entre cierre/pago de liquidación y reverso, proyección contable de reversos, recargas y conciliación bancaria con fallos inyectados |
| Transacciones heredadas | Sustituir usos de `BEGIN`/`COMMIT` en llamadas HTTP separadas de rutas Admin por transacciones soportadas o una sola sentencia atómica |
| Infraestructura real | Base e identidad separadas, migraciones completas y reproducibles, secretos propios y prueba de carga sobre ese entorno |
| Seguridad externa | Revisar dependencias, rate limiting y realizar pruebas de autorización entre empresas/comercios con cuentas reales de prueba |

El registro durable agregado aquí cubre la aprobación del consumo; no demuestra que todos los procesos contables y de liquidación toleren interrupciones. Tampoco se ha realizado un simulacro de restauración ni una auditoría externa.

## Procedimiento de recuperación por validar

1. Registrar incidente, hora, último movimiento consistente y alcance. Pausar las mutaciones afectadas y preservar logs sin credenciales ni datos personales innecesarios.
2. Restaurar el respaldo o punto de recuperación en una base aislada. No sobrescribir la base operativa como primer paso.
3. Conciliar transacciones, ledger, saldos, eventos contables y pagos externos. Reprocesar eventos pendientes de forma idempotente; no repetir pagos bancarios por una respuesta incierta.
4. Ejecutar pruebas funcionales y verificar accesos en el entorno recuperado. Documentar RTO/RPO observados y obtener la validación del responsable operativo.
5. Reanudar de forma controlada y conciliar nuevamente. Conservar evidencia y corregir la causa del incidente.

Ante una regresión de esta entrega, preferir una corrección hacia adelante o pausar la función afectada. La versión anterior conserva los accesos legacy retirados; un rollback a ella reintroduciría esa exposición.
