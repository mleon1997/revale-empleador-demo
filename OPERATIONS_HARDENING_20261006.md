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
- La alerta horaria a Mateo en ChatGPT quedó creada y habilitada. Revisa disponibilidad, salud operativa y errores recientes; requiere repetición del fallo antes de avisar. No equivale a un servicio de guardia con aviso inmediato o garantía de entrega. Falta un simulacro de entrega de incidente.

Respuesta a una alerta: revisar el último despliegue y los conteos autenticados; detener el flujo afectado; conciliar banco, pagos, ledger y outbox antes de reintentar. Nunca repetir una transferencia externa por una respuesta incierta. Registrar causa, responsable y evidencia de recuperación.

## Recuperación reproducible

`npm run test:restore` requiere PostgreSQL local desechable y el contenedor del servicio de CI. Crea otra base; nunca sobrescribe una existente. Realiza `pg_dump`/`pg_restore` con la misma versión del servidor, verifica todas las filas por tabla, estado de secuencias e invariantes financieras y registra tiempo observado. Solamente utiliza datos sintéticos.

### Restauración del respaldo real: 6 de octubre de 2026

Se verificó el proyecto conectado a la identidad y a los datos de ReVale. Desde Neon Console se creó un snapshot manual de `main` a las 01:36:26 UTC y se ejecutó **Multi-step restore** en una rama nueva del mismo proyecto. El origen y las conexiones de la aplicación no se modificaron; no se ejecutó «Migrate connections and settings».

- Neon confirmó la restauración y reportó **0,39 segundos** para crear la rama. Ese tiempo no representa el RTO de la aplicación ni incluye comprobaciones, configuración de Auth o cambio de tráfico.
- Origen y destino coincidieron en las **67 tablas y 1.469 filas** de los esquemas de aplicación e identidad, utilizando conteos y huellas de todas las filas serializadas de forma ordenada. También coincidieron las huellas de metadatos de columnas y estados de secuencias del esquema de aplicación.
- Seis controles en la base restaurada resultaron en cero: saldos negativos, pagos activos duplicados, asientos publicados descuadrados o vacíos, eventos contables con error o atrasados, pagos sin contabilización y conciliaciones con diferencias.
- El endpoint de salud de la aplicación original respondió **200 / `{ok:true}`** después del ensayo.
- Plan observado: **Free**, historial recuperable **6 horas**, **un snapshot manual sin expiración**, sin programación de respaldos. La consola indica que se alcanzó el límite gratuito de snapshots y que la programación requiere otro plan.

La evidencia visual queda guardada de forma privada junto con la entrega. La rama de recuperación sigue disponible para inspección. Este ensayo prueba recuperación de datos dentro del mismo proveedor y proyecto; no constituye separación física de entornos, copia externa independiente ni recuperación frente a una caída completa del proveedor. Aunque se restauraron las tablas de identidad, no se habilitó el servicio Auth en el destino ni se probó un cambio integral de la aplicación. Faltan respaldos recurrentes con retención acordada, objetivos RTO/RPO y simulacro completo con autenticación y conciliación bancaria. No copiar datos reales a desarrollo ni dar por recuperado un pago sin cotejarlo con el banco.

## Frentes pendientes

| Frente | Evidencia actual | Siguiente acción concreta |
| --- | --- | --- |
| Separación física | Vercel respondió 403 al administrar integraciones. La organización Neon administrada por Vercel tiene «New project» deshabilitado. No se crearon proyectos nuevos. El código impide que preview use la conexión demo heredada. | Completar acceso administrativo de Vercel y crear proyectos independientes, con identidad y credenciales propias; registrar recursos y comprobar que cada credencial falla al acceder a otro entorno. |
| Recuperación operativa | Snapshot real restaurado y datos comparados. Historial de seis horas, sin programación y sin prueba integral de conmutación. | Aprobar retención/coste, programar respaldos y probar recuperación completa, incluyendo identidad, aplicación y conciliación externa. Verificar también la migración reproducible del esquema heredado. |
| MFA | La instancia de Neon Auth no expone MFA en sus 78 rutas OpenAPI. La consola muestra únicamente plugins de organizaciones, magic link y teléfono. La cuenta administradora Neon ofrece configurar 2FA; la organización indica «MFA not required» y el botón para exigirlo está deshabilitado. | El titular debe enrolar su autenticador y guardar sus códigos de recuperación; después verificar exigencia organizativa. Para ReVale, elegir identidad con MFA soportado e integrar desafío y verificación del servidor para privilegios financieros, enrolar cuentas nominativas y probar recuperación/revocación. |

Propuesta de aislamiento: proyectos de base e identidad distintos para cada entorno; proyectos de aplicación y variables por ámbito; credenciales operativas sin privilegio de DDL y credenciales de migración separadas; datos sintéticos en staging; ninguna sincronización automática de datos reales hacia demo. El endpoint de autenticación distinto por sí solo no prueba aislamiento físico.

## Límites de esta revisión

Las pruebas automatizadas usan un esquema sintético basado en las consultas y migraciones del repositorio. La comparación de la restauración verificó el esquema real contra su copia, no su equivalencia con las migraciones sintéticas. Falta inventariar datos heredados, cerrar esa equivalencia, ejecutar carga y medir latencias/contención. El cierre actual implementa semanas de lunes a lunes en America/Guayaquil; otros calendarios, incluyendo quincenas, requieren una definición comercial e implementación verificable. No se modificaron tasas fiscales ni se certificó cumplimiento tributario. Faltan MFA efectivo, recuperación integral y recurrente, segregación física comprobada, responsables de guardia y prueba de entrega de avisos antes de calificar la operación como lista para fondos reales.
