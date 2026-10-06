-- Better Auth 1.7.7; isolated staging identity only. No existing identity data is copied.
BEGIN;
create schema if not exists "revale_identity";

create table "revale_identity"."user" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null, "twoFactorEnabled" boolean);

create table "revale_identity"."session" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" uuid not null references "revale_identity"."user" ("id") on delete cascade, "mfaVerified" boolean not null);

create table "revale_identity"."account" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "accountId" text not null, "providerId" text not null, "userId" uuid not null references "revale_identity"."user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

create table "revale_identity"."verification" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "revale_identity"."twoFactor" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "secret" text not null, "backupCodes" text not null, "userId" uuid not null references "revale_identity"."user" ("id") on delete cascade, "verified" boolean, "failedVerificationCount" integer, "lockedUntil" timestamptz);

create table "revale_identity"."rateLimit" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

create index "session_userId_idx" on "revale_identity"."session" ("userId");

create index "account_userId_idx" on "revale_identity"."account" ("userId");

create index "verification_identifier_idx" on "revale_identity"."verification" ("identifier");

create index "twoFactor_secret_idx" on "revale_identity"."twoFactor" ("secret");

create index "twoFactor_userId_idx" on "revale_identity"."twoFactor" ("userId");
COMMIT;
