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

## Recursos separados creados: 6 de octubre de 2026, 02:00 UTC aproximadamente

Con autorización explícita se crearon dos proyectos Neon nuevos desde la integración existente de Vercel, en el plan Free y región Washington (iad1), con Auth habilitado:

| Entorno | Proyecto Neon | Recurso Vercel |
| --- | --- | --- |
| Demo existente | `frosty-salad-11481853` (`revale-pilot-parallel`) | `store_AiZ7rIxwvWGxwGV0` |
| Staging nuevo | `lively-cloud-95086101` (`revale-staging`) | `store_KJQIyrfQH3SO28WE` |
| Live nuevo | `wild-forest-04830559` (`revale-live`) | `store_CdaU0EU2PWb6lPRO` |

Las consultas iniciales de solo lectura en cada recurso nuevo verificaron cero tablas del esquema `revale`, nueve tablas de `neon_auth`, cero usuarios y cero sesiones. Después de la autorización adicional del titular se instaló y verificó el esquema vacío en ambos proyectos, como se detalla abajo. No se copiaron datos ni identidades de la demo. Los recursos nuevos todavía no están conectados a proyectos de aplicación; no equivalen a entornos funcionales listos para uso.

Se actualizó la conexión de la demo a `revale-comercios` para que aplique únicamente a Production y se restringió también la variable independiente `NEON_AUTH_URL`. La API de configuración de Vercel confirmó que las 19 variables `REVALE_DB_*` y `NEON_AUTH_URL` quedan solo en Production, sin variables de base/autenticación en Preview. Esta retirada afecta futuros despliegues; los despliegues históricos conservan su configuración y requieren retiro o redespliegue. No se cambiaron los valores de Production ni se realizó un nuevo despliegue.

El acceso a Neon Console mediante «Open in Neon» quedó en «Verify your email»: Neon envió un enlace para vincular la cuenta con VercelMarketplace. Se requiere intervención del titular para completar esa verificación. La comprobación adicional de salud no pudo ejecutarse en este turno: el conector fue rechazado por poder crear un enlace de bypass y el intento público sin bypass fue bloqueado por el navegador (`ERR_BLOCKED_BY_CLIENT`). No se afirma una nueva validación de disponibilidad.

## Migración estructural instalada y verificada: 6 de octubre de 2026

Se obtuvo desde el editor de consultas de Vercel un catálogo de solo estructura del esquema `revale` actual: 58 tablas, 20 secuencias, 149 índices y 270 restricciones (58 claves primarias, 24 únicas, 105 foráneas y 83 comprobaciones). No hay funciones, triggers, políticas RLS, enums ni tipos independientes en ese esquema. Todas las claves foráneas apuntan al propio esquema `revale`.

`db/baseline/20261006_revale.sql` reconstruye ese esquema vacío en una transacción. No copia usuarios, registros financieros, estados de secuencias, propietarios ni grants. La consulta de extracción y el catálogo observado se conservan junto a la migración para comparación reproducible. Hash SHA-256 del SQL: `fdef41fd8c244f15093054f042c744ed3c73e247c85a973cfb437daed296cd5e`.

`npm run test:baseline` pasó localmente en PGlite en sus dos rutas: script transaccional y consulta preparada de una sentencia. Ambas comparan cada definición de tabla/columna, restricción, índice y secuencia con el catálogo de origen; verifican cero filas y ausencia de instalación de identidades; comprueban que una segunda ejecución se rechaza y preserva el esquema. Una tercera prueba exige que el bloque de una sentencia contenga exactamente el DDL aprobado. La prueba también se incorporó al workflow local; todavía no se publicó ni se ejecutó en GitHub en esta entrega.

Tras el rechazo inicial de la revisión automática, el titular autorizó explícitamente instalar la migración en staging y live, validando primero staging. El editor de Vercel rechazó el script con varias sentencias (`cannot insert multiple commands into a prepared statement`) antes de ejecutarlo. Se generó `db/baseline/20261006_revale-query.sql`: un bloque `DO` atómico que ejecuta exactamente el mismo DDL, sin los delimitadores de transacción externos. Su SHA-256 es `1983685e2aa0f301ce42fb3a0ccacb8a9bcda36088aec5f478bb5bf0ceb3104b`.

Se instaló el bloque en staging y, después de validar todo su catálogo y ausencia de datos, se instaló en live. Ambos editores confirmaron `Query executed successfully` y se restablecieron a solo lectura. Se consultó después el catálogo remoto completo y se comparó exactamente con el catálogo de origen; no se usaron solo conteos para afirmar equivalencia.

| Comprobación | Staging | Live |
| --- | ---: | ---: |
| Tablas / columnas de aplicación | 58 / 678 | 58 / 678 |
| Restricciones / índices / secuencias | 270 / 149 / 20 | 270 / 149 / 20 |
| Catálogo completo coincide con origen | Sí | Sí |
| Filas de aplicación, sumando las 58 tablas | 0 | 0 |
| Secuencias utilizadas | 0 | 0 |
| Tablas Auth / usuarios / sesiones | 9 / 0 / 0 | 9 / 0 / 0 |

Ambos servidores reportaron PostgreSQL `18.6 (4e955f5)`. La consulta reproducible está en `db/baseline/verify-empty.sql` y el registro agregado, sin credenciales ni filas personales, en `db/baseline/verification-20261006.json`.

La migración no crea roles operativos, cuentas humanas ni configuración comercial/contable inicial. Esos elementos, la conexión por ámbito, el despliegue y las pruebas de acceso cruzado siguen pendientes antes de fondos reales. El acceso de Neon Console por la integración sigue pendiente de la verificación por correo observada; esta instalación mediante el editor de Vercel no demuestra que esa verificación se haya completado.

## Preparación de la aplicación staging

Se creó el proyecto Vercel `revale-staging` (`prj_JDzorjuwv6YgvC2EZMdWGgxoMGmU`), con Node.js 22 y protección `all_except_custom_domains`, sin dominios personalizados ni conexiones de base/identidad. Sus dos variables iniciales, `REVALE_MODE=live` y `REVALE_SCHEMA_MODE=managed`, se limitan a Preview. El código preparado impide DDL y asignación automática de permisos financieros en Preview/live; exige un origen Auth propio y rechaza la reutilización de conexiones conocidas entre Preview y live.

Se preparó y probó un rol de ejecución sin login y sin DELETE/TRUNCATE/DDL ni acceso a las tablas de identidad; todavía no se instaló remotamente ni se provisionó una credencial. Las 63 pruebas locales de seguridad, empleador y liquidaciones pasaron. Luego GitHub Actions validó 75 pruebas totales, sin fallos ni omisiones, incluidos nueve casos de concurrencia con PostgreSQL, más restauración sintética y build. Se publicó el commit `fc807a958688bbf592fbc69dc7004ed0e8b5a742` en el nuevo proyecto de staging; Vercel confirmó READY y el portal de login carga. La conexión DB/Auth y la prueba funcional integral siguen pendientes. El procedimiento y los pasos pendientes están en `STAGING_SETUP.md`.

## Frentes pendientes

| Frente | Evidencia actual | Siguiente acción concreta |
| --- | --- | --- |
| Separación física | Staging y live creados como proyectos Neon independientes; esquema vacío instalado y catálogo completo verificado, con Auth y sin usuarios heredados. Credenciales demo retiradas de la configuración de futuros previews. Falta preparar y conectar aplicaciones. | Completar la verificación por correo de Neon; crear configuración inicial y credenciales operativas de privilegio mínimo, conectar aplicaciones por ámbito, probar rechazo cruzado de credenciales/sesiones y retirar o redesplegar previews históricos. |
| Recuperación operativa | Snapshot real restaurado y datos comparados. Historial de seis horas, sin programación y sin prueba integral de conmutación. | Aprobar retención/coste, programar respaldos y probar recuperación completa, incluyendo identidad, aplicación y conciliación externa. Incluir el esquema heredado ya reproducido en el próximo simulacro integral. |
| MFA | La instancia de Neon Auth no expone MFA en sus 78 rutas OpenAPI. La consola muestra únicamente plugins de organizaciones, magic link y teléfono. La cuenta administradora Neon ofrece configurar 2FA; la organización indica «MFA not required» y el botón para exigirlo está deshabilitado. | El titular debe enrolar su autenticador y guardar sus códigos de recuperación; después verificar exigencia organizativa. Para ReVale, elegir identidad con MFA soportado e integrar desafío y verificación del servidor para privilegios financieros, enrolar cuentas nominativas y probar recuperación/revocación. |

Propuesta de aislamiento: proyectos de base e identidad distintos para cada entorno; proyectos de aplicación y variables por ámbito; credenciales operativas sin privilegio de DDL y credenciales de migración separadas; datos sintéticos en staging; ninguna sincronización automática de datos reales hacia demo. El endpoint de autenticación distinto por sí solo no prueba aislamiento físico.

## Límites de esta revisión

Las pruebas automatizadas usan un esquema sintético basado en las consultas y migraciones del repositorio. La comparación de la restauración verificó el esquema real contra su copia, no su equivalencia con las migraciones sintéticas. El catálogo completo del esquema real se reprodujo y comparó exactamente en staging y live, ambos vacíos. Falta inventariar datos heredados, validar la configuración operativa inicial, ejecutar carga y medir latencias/contención. El cierre actual implementa semanas de lunes a lunes en America/Guayaquil; otros calendarios, incluyendo quincenas, requieren una definición comercial e implementación verificable. No se modificaron tasas fiscales ni se certificó cumplimiento tributario. Faltan MFA efectivo, recuperación integral y recurrente, segregación física comprobada, responsables de guardia y prueba de entrega de avisos antes de calificar la operación como lista para fondos reales.
