# Staging: recorrido financiero con MFA y recuperación

Verificado el 6 de octubre de 2026, 13:27 America/Guayaquil.

## Resultado

El despliegue `dpl_6sjmLTH2jyNBXsw4JaeD8UTfcfrs` completó por HTTP un
recorrido financiero sintético con sesiones MFA y credenciales restringidas.
Se usaron un empleado, un supervisor y dos usuarios financieros distintos.
La prueba no ejecutó transferencias bancarias ni emitió documentos fiscales.

| Comprobación | Resultado |
| --- | --- |
| Operar solo con contraseña | Rechazado para los cuatro usuarios |
| Consumo de USD 20 y tres reversos simultáneos | Una sola devolución; saldo USD 100 |
| Consumo de USD 100 y tres confirmaciones simultáneas | Un solo descuento; saldo USD 0 |
| Repetir creación del cobro con la misma clave | Misma transacción |
| Solicitar y aprobar el pago con el mismo usuario | Rechazado |
| Aprobar con el segundo usuario | Aprobación independiente ejecutada |
| Comisión / impuesto sintéticos | USD 2,50 / USD 0,38 |
| Pago neto registrado y repetido | USD 97,12, un único payout |
| Conciliar USD 97,11 | Diferencia de USD 0,01 detectada por salud operativa |
| Conciliar USD 97,12 y repetir | Conciliada; un único evento; saldo del comercio USD 0 |
| Controles financieros al terminar | Los ocho sin anomalías |

El saldo inicial de USD 100 y el asiento de fondeo se cargaron como fixture,
no mediante el circuito de recepción y asignación de una empresa. Las fechas
de los dos consumos ficticios se ubicaron en el período semanal terminado para
ejercitar la ruta de cierre existente. El ejercicio no valida un ciclo quincenal.
La prueba fue HTTP; no sustituye el enrolamiento de una persona con su autenticador.
Se comprobó el detector de anomalías, no la entrega de una notificación externa.

## Error encontrado y corregido

La restricción `settlements_status_check` del esquema observado no admitía
`reconciled`, aunque la aplicación ya escribía ese estado. La conciliación exacta
fallaba con SQLSTATE 23514 y revertía su transacción. Las pruebas anteriores
utilizaban una definición simplificada de esa tabla y no lo detectaban.

Se aplicó exclusivamente a staging
`db/migrations/20261006_settlement_reconciled_status.sql`. Preserva todos los
estados anteriores y admite `reconciled`. No modifica importes ni elimina filas.
La nueva regresión carga el esquema completo de 58 tablas, reproduce el fallo,
comprueba rollback, aplica la migración y valida conciliación, reintento y rechazo
de estados inválidos. Demo y live todavía requieren esta migración antes de usar
ese recorrido; no se aplicó allí en esta entrega.

## Recuperación

CI restauró un `pg_dump` de 44 tablas financieras sintéticas y seis de identidad
en otra base PostgreSQL. Comparó filas y secuencias antes de modificar el destino,
comprobó los controles financieros y luego validó contraseña, TOTP y recuperación.

La prueba demuestra que la clave de cifrado correspondiente es necesaria y que
una clave diferente no recupera los factores. Revoca sesiones y desafíos en el
destino antes de volver a permitir acceso; la sesión del origen sigue funcionando.
Los códigos ya consumidos continúan rechazados y un código disponible solo sirve
una vez. La clave de prueba se conserva separadamente en memoria y no se publica.

Esto no acredita recuperación de la clave desplegada desde una bóveda ni una
restauración real de las nuevas identidades de staging. La restauración real de
la demo registrada previamente no incluía estas tablas nuevas.

CI del cambio: https://github.com/mleon1997/revale-empleador-demo/actions/runs/37511549754
(86 pruebas, ninguna omitida; restauración y compilación aprobadas).

## Cierre y próximos pasos

Se revocó el enlace temporal antes de sus 15 minutos. Las cuatro identidades,
sesiones, factores y desafíos quedaron en cero; se desactivaron membresías,
entidades y permisos ficticios, conservando los registros financieros para auditoría.
También se retiraron las credenciales temporales del workspace. No se alteraron
demo, live ni sus variables. La evidencia está en
`db/baseline/staging-financial-verification-20261006.json`.

Para continuar hace falta definir el correo del administrador humano y la persona
que ejercerá el segundo control. Deben inscribir personalmente sus autenticadores.
También quedan la custodia y recuperación real de la clave de identidad, MFA de
las cuentas de proveedores, la prueba de invitaciones en navegador y la revisión
independiente. El proveedor MFA aún se limita por código a Preview: live necesita
su configuración y revisión propias. No se habilita operación con fondos reales.
