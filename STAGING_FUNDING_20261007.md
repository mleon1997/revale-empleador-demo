# Carga y asignación de beneficios en staging

Verificado el 7 de octubre de 2026. Despliegue `dpl_DFZw3vBcXAcaRqMfAfcFvfj5ZLKd`,
commit `5336d34b0c195641e05324484264f76b9aee3000`.

## Resultado

Prueba HTTP contra staging, con cinco identidades ficticias y MFA: solicitante y
aprobador de empresa, solicitante y aprobador de backoffice, y empleada Andrea de
prueba. No se utilizaron contraseñas ni factores de Mateo. No hubo transferencia
bancaria real, cambio de demo/live ni validación visual de interfaces.

| Paso | Resultado |
| --- | --- |
| Solicitar USD 100 desde empresa y repetir | Un solo lote; saldo del empleado USD 0 |
| Reutilizar la referencia con USD 101 | Rechazado |
| Aprobar con el solicitante de empresa | Rechazado |
| Aprobar con otro usuario de empresa y repetir | Una decisión efectiva |
| Acreditar antes de registrar el ingreso | Rechazado |
| Registrar recepción ficticia y repetir | Un solo recibo confirmado; saldo USD 0 |
| Crear solicitud con usuario solo aprobador | Rechazado |
| Crear solicitud financiera y repetir | Una solicitud |
| Aprobar con el solicitante financiero | Rechazado |
| Aprobar con la segunda cuenta financiera | Saldo USD 100 |
| Tres reintentos simultáneos tras aprobación | HTTP 409; ningún crédito adicional |
| Portal del empleado, vía API | Saldo USD 100 y una entrada de historial |
| Portal de empresa, vía API | Lote `credited`, un recibo y una asignación |
| Contabilidad | Caja +100; prefondos 0; obligación con empleado 100 |

Lote: `fund_ad0cf2eb295341ad002a592ebaaa54b3`. La contabilidad del ensayo cuadra;
esto no representa corroboración de un depósito bancario real.

## Fallo corregido

`registerFundingReceipt` pasaba `$2` sin tipo a `jsonb_build_object` al actualizar
la referencia bancaria. PostgreSQL rechazaba la consulta con `42P18`; la API
respondía 500 y revertía su transacción. Se añadió `$2::text`.

La nueva regresión carga las 58 tablas del esquema observado, reproduce el error,
comprueba rollback y valida recepción, asignación, reintentos y asientos. CI:
https://github.com/mleon1997/revale-empleador-demo/actions/runs/37638154079
— 89 pruebas aprobadas, cero fallos/omisiones, compilación y restauración sintética
de 50 tablas aprobadas.

Durante el diagnóstico se invocó aisladamente la función de recepción: creó un
recibo ficticio antes del error, sin asiento ni asignación. Se conservó como
`voided`, con motivo de diagnóstico, antes de repetir la prueba HTTP. No se contó
ese registro anulado como recepción efectiva.

## Cierre y prueba personal

Los dos enlaces temporales fueron revocados. Las cinco identidades ficticias se
eliminaron, sus membresías se desactivaron y se conservaron los registros
financieros. También se desactivó la política sintética de asignación. Los dos
usuarios humanos mantienen sus accesos y MFA.

Después de la autorización explícita del usuario, el 7 de octubre de 2026 se
habilitó `mateo@revale.app` con `can_make=true`, `can_approve=false` y permiso
activo únicamente en staging. Se registró el alta en auditoría. La verificación
posterior confirmó que ambas cuentas conservan MFA activo.

El segundo correo mantiene `can_make=false`, `can_approve=true` y límite de
USD 100. Ambos pertenecen a la misma persona; este esquema separa cuentas, no
personas. El límite numérico del solicitante no limita la creación de solicitudes;
la aprobación depende de la política y del límite del aprobador.

Para el ensayo personal queda preparar un nuevo caso ficticio con política activa.
La revisión de recuperación real y la preparación de producción continúan fuera
del alcance de esta prueba.

Evidencia: `db/baseline/staging-funding-verification-20261007.json`.
