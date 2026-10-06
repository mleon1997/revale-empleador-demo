import test from 'node:test';
import { identityFixture } from './identity-fixture.mjs';
import { prepareRecoveryFixture, verifyIdentityAfterRestore } from './identity-restore-helpers.mjs';

test('recovery procedure revokes restored sessions and requires the original factor encryption key',async()=>{
  const f=await identityFixture();
  try {
    const state=await prepareRecoveryFixture(f);
    // This checks the recovery procedure against the synthetic snapshot state;
    // restore-drill.mjs separately proves pg_dump -> new database -> this flow.
    await verifyIdentityAfterRestore(f,state);
  } finally { await f.close(); }
});
