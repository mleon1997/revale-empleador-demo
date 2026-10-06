# ReVale: controles operativos y revisión de liquidaciones

Fecha: 6 de octubre de 2026 (UTC). El entorno publicado continúa en modo demo. Esta entrega no autoriza fondos reales.

## Correcciones implementadas

1. Las mutaciones Admin y los reversos de comercios usan una conexión PostgreSQL real, aislamiento Serializable, bloqueo transaccional compartido y reintentos acotados. Validación, actualización, asiento contable y auditoría confirman o revierten conjuntamente. La respuesta HTTP se publica después del commit. Ningún pago externo debe ejecutarse dentro de estos callbacks repetibles.
2. Los pagos reservan tanto la obligación disponible del comercio como la caja disponible de la cuenta de origen. Se bloquean si faltan asientos, hay eventos contables pendientes, la cuenta aprobada cambió, el saldo bancario está desactualizado o el importe excede la autorización.
3. Al ejecutar una aprobación se vuelven a comprobar vencimiento, política vigente, número de aprobadores, permisos activos, roles, límites y separación entre solicitante y aprobador.
4. Los reintentos de programación y pago son idempotentes. Una referencia bancaria ya utilizada no puede atribuirse a otro pago. Un pago finalizado no puede cambiar a fallido.
5. Se exige conciliación exacta al centavo. Una conciliación confirmada no puede sobrescribirse; una corrección requiere un procedimiento explícito.
6. Un reverso ya contabilizado no se vuelve a contabilizar como post-cierre al reintentarlo posteriormente. La devolución de comisión e impuesto queda limitada al valor efectivamente reconocido, incluyendo el remanente de redondeo del último reverso.
7. Retenciones, factura, notas de crédito y ajustes se prueban antes de permitir el pago restante. Se corrigieron parámetros SQL sin tipo que impedían programar pagos, registrar documentos y conciliar.

Los pagos siguen siendo registros administrativos con evidencia bancaria. No se incorporó un emisor automático de transferencias ni se enviaron pagos de prueba al banco.

## Vigilancia

- `/api/operational-health`: devuelve únicamente `{ok:true}` (200) o `{ok:false}` (503), sin identidades, importes, referencias ni errores SQL. Cache interno de 30 segundos para amortiguar sondeos simultáneos.
- Detecta saldos negativos, pagos duplicados, asientos descuadrados, eventos contables con error o pendientes por más de cinco minutos, pagos sin contabilización, conciliaciones con diferencias, aprobaciones atascadas y saldos bancarios vencidos.
- `/api/admin?action=operational-health`: conteos detallados, solamente para administradores y finanzas autenticados. Los logs operativos contienen conteos, sin datos financieros individuales.
- Workflow `ReVale operational health`: disponibilidad e integridad cada 15 minutos y ejecución manual. GitHub puede retrasar los cron; las notificaciones de fallos dependen de las preferencias de la cuenta.
- La alerta horaria a Mateo en ChatGPT se configura aparte y requiere confirmar que la tarea quedó creada. No equivale a un servicio de guardia con aviso inmediato o garantía de entrega.

Respuesta a una alerta: revisar el último despliegue y los conteos autenticados; detener el flujo afectado; conciliar banco, pagos, ledger y outbox antes de reintentar. Nunca repetir una transferencia externa por una respuesta incierta. Registrar causa, responsable y evidencia de recuperación.

## Recuperación reproducible

`npm run test:restore` requiere PostgreSQL local desechable y el contenedor del servicio de CI. Crea otra base; nunca sobrescribe una existente. Realiza `pg_dump`/`pg_restore` con la misma versión del servidor, verifica todas las filas por tabla, estado de secuencias e invariantes financieras y registra tiempo observado. Solamente utiliza datos sintéticos.

La recuperación real aún requiere: acceso administrativo al proyecto Neon correcto; verificar plan, retención e historial disponible; elegir un punto conocido; restaurar en un proyecto de recuperación aislado; cotejar saldos, eventos y extractos; medir RTO/RPO; validar autenticación, permisos y funcionamiento; guardar evidencia y aprobación operativa. No copiar datos reales a desarrollo. No dar por recuperado un pago sin cotejarlo con el banco.

## Tres frentes que requieren acceso adicional

| Frente | Evidencia actual | Siguiente acción concreta |
| --- | --- | --- |
| Separación física | La conexión Vercel respondió 403 al listar/administrar integraciones. No se crearon bases nuevas. El código impide que preview use la conexión demo heredada. | Crear recursos demo, staging, live y recuperación separados, con identidad y credenciales propias; registrar IDs de proyectos/base/ramas; comprobar que cada credencial falla al acceder a otro entorno. |
| Respaldo real | No se dispone de conexión administrativa ni respaldo accesible; no se ha restaurado Neon. | Ejecutar el procedimiento anterior sobre un punto real y verificar también la migración del esquema heredado. |
| MFA | El esquema OpenAPI de la instancia actual de Neon Auth expone 78 rutas y ninguna de MFA/TOTP/WebAuthn/passkeys. El servicio administrado no permite activar arbitrariamente un plugin Better Auth. | Habilitar y probar MFA en cuentas proveedoras; elegir una solución de identidad con MFA soportado; integrar desafío y verificación del servidor para privilegios financieros, enrolar cuentas nominativas y probar recuperación/revocación. No sustituir MFA por un indicador en la interfaz. |

Propuesta de aislamiento: proyectos de base e identidad distintos para cada entorno; proyectos de aplicación y variables por ámbito; credenciales operativas sin privilegio de DDL y credenciales de migración separadas; datos sintéticos en staging; ninguna sincronización automática de datos reales hacia demo. El endpoint de autenticación distinto por sí solo no prueba aislamiento físico.

## Límites de esta revisión

Las pruebas automatizadas usan un esquema sintético basado en las consultas y migraciones del repositorio. Falta compararlo contra el esquema real, inventariar datos heredados, ejecutar carga y medir latencias/contención. El cierre actual implementa semanas de lunes a lunes en America/Guayaquil; otros calendarios, incluyendo quincenas, requieren una definición comercial e implementación verificable. No se modificaron tasas fiscales ni se certificó cumplimiento tributario. Faltan MFA efectivo, restauración real, segregación física comprobada, responsables de guardia y prueba de entrega de avisos antes de calificar la operación como lista para fondos reales.
