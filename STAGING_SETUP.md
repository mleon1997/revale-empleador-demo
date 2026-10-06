# ReVale staging: estado y procedimiento

Actualizado el 6 de octubre de 2026 (America/Guayaquil).

## Recursos y configuración efectiva

- Vercel: `revale-staging`, proyecto `prj_JDzorjuwv6YgvC2EZMdWGgxoMGmU`,
  equipo `team_zDuKjsH2sqTcMSoRzFV5bdQ3`; Vite y Node.js 22.
- Dominio de staging: https://revale-staging-mateo-leon-s-projects.vercel.app
- Protección Vercel `all_except_custom_domains`; sin dominios personalizados.
- Neon: proyecto `lively-cloud-95086101`, rama `br-ancient-darkness-b8aqist7`,
  base `neondb`. Esquema `revale`: 58 tablas, sin datos reales.
- `REVALE_MODE=live` y `REVALE_SCHEMA_MODE=managed` solo en Preview: aplican
  controles estrictos y prohíben inicializadores DDL/semillas en solicitudes.
- `REVALE_PREVIEW_DATABASE_URL`: login `revale_staging_app`, únicamente miembro
  de `revale_runtime`. SELECT/INSERT/UPDATE en negocio y USAGE/SELECT en secuencias;
  sin DELETE, TRUNCATE, DDL, propiedad ni membresía `neon_superuser`.
- `REVALE_PREVIEW_AUTH_URL` conserva el proveedor administrado independiente de
  staging. `REVALE_AUTH_ORIGIN` apunta al dominio canónico de staging.
- El ensayo MFA usa `REVALE_AUTH_PROVIDER=better-auth-mfa`, una conexión distinta
  `REVALE_PREVIEW_IDENTITY_DATABASE_URL` y `REVALE_PREVIEW_IDENTITY_SECRET`,
  exclusivamente en Preview. Su estado y evidencia están en [STAGING_MFA.md](STAGING_MFA.md).

## Límites de la activación

La aplicación de staging tiene sus conexiones restringidas instaladas. Las notas
anteriores que describían una base sin credenciales y MFA pendiente de instalación
quedaron sustituidas por este estado y por STAGING_MFA.md.

Las identidades de Neon Auth administrado y Better Auth son independientes; no se
migraron contraseñas, usuarios ni datos de demo/live. Las cuentas de prueba usan
UUID explícitos y correos `example.invalid`. No se configuraron cuentas humanas,
plan contable ni fondos para una prueba financiera integral.

El código permanece en `fix/staging-mfa`, PR de borrador contra
`fix/operational-readiness`; no se fusionó en main ni se desplegó una aplicación live.

## Operación

1. Instalar nuevas migraciones con credencial administrativa y revisar sus grants.
   Los roles de ejecución no heredan permisos automáticos sobre objetos nuevos.
2. Conservar las variables exclusivamente en el entorno correspondiente y desplegar
   un commit probado con `target=staging` (Preview en Vercel).
3. Verificar permisos efectivos, principal de cada portal, MFA y aislamiento antes
   de introducir usuarios humanos o datos operativos.
4. Cualquier acceso temporal de prueba debe tener vencimiento y revocación explícita;
   nunca guardar el enlace o sus secretos en Git.
5. Restauración del esquema de identidad, recuperación humana y flujos financieros
   integrados siguen pendientes; el ensayo de CI usa bases sintéticas.
