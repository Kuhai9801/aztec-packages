import { Fr } from '@aztec/foundation/curves/bn254';
import { Point } from '@aztec/foundation/curves/grumpkin';

import { AztecAddress } from '../aztec-address/index.js';
import { CompleteAddress } from '../contract/complete_address.js';
import { deriveMasterIncomingViewingSecretKey } from '../keys/derivation.js';
import { randomExtendedDirectionalAppTaggingSecret } from '../tests/factories.js';
import {
  ExtendedDirectionalAppTaggingSecret,
  computeSharedTaggingSecret,
} from './extended_directional_app_tagging_secret.js';

describe('ExtendedDirectionalAppTaggingSecret', () => {
  it('toString and fromString works', async () => {
    const secret = await randomExtendedDirectionalAppTaggingSecret();
    const str = secret.toString();
    const parsed = ExtendedDirectionalAppTaggingSecret.fromString(str);

    expect(parsed.secret).toEqual(secret.secret);
    expect(parsed.app).toEqual(secret.app);
  });

  it('is a deterministic function of the point, app and recipient', async () => {
    const point = await Point.random();
    const app = await AztecAddress.random();
    const recipient = await AztecAddress.random();

    const a = await ExtendedDirectionalAppTaggingSecret.compute(point, app, recipient);
    const b = await ExtendedDirectionalAppTaggingSecret.compute(point, app, recipient);
    expect(b.secret).toEqual(a.secret);

    const otherApp = await ExtendedDirectionalAppTaggingSecret.compute(point, await AztecAddress.random(), recipient);
    expect(otherApp.secret).not.toEqual(a.secret);

    const otherRecipient = await ExtendedDirectionalAppTaggingSecret.compute(point, app, await AztecAddress.random());
    expect(otherRecipient.secret).not.toEqual(a.secret);
  });

  // Registering a pre-shared tagging secret point directly must yield the same directional secret as the ECDH-derived
  // sender path. Both sides of the Diffie-Hellman exchange compute the same shared point, so a recipient that registers
  // that point discovers exactly the tags a sender would emit.
  it('a directly registered shared point matches the ECDH-derived sender secret', async () => {
    const recipientSecretKey = Fr.random();
    const recipientComplete = await CompleteAddress.fromSecretKeyAndPartialAddress(recipientSecretKey, Fr.random());
    const recipientIvsk = deriveMasterIncomingViewingSecretKey(recipientSecretKey);

    const senderSecretKey = Fr.random();
    const senderComplete = await CompleteAddress.fromSecretKeyAndPartialAddress(senderSecretKey, Fr.random());
    const senderIvsk = deriveMasterIncomingViewingSecretKey(senderSecretKey);

    const app = await AztecAddress.random();

    // The recipient derives the shared point against the sender
    const pointFromRecipient = await computeSharedTaggingSecret(
      recipientComplete,
      recipientIvsk,
      senderComplete.address,
    );
    // The sender derives the same point against the recipient (Diffie-Hellman symmetry)
    const pointFromSender = await computeSharedTaggingSecret(senderComplete, senderIvsk, recipientComplete.address);

    expect(pointFromRecipient).toBeDefined();
    expect(pointFromSender).toEqual(pointFromRecipient);

    const secretViaEcdh = await ExtendedDirectionalAppTaggingSecret.compute(
      pointFromRecipient!,
      app,
      recipientComplete.address,
    );
    // Registering the shared point directly (bypassing ECDH) derives the identical secret.
    const secretViaRegistration = await ExtendedDirectionalAppTaggingSecret.compute(
      pointFromSender!,
      app,
      recipientComplete.address,
    );

    expect(secretViaRegistration.secret).toEqual(secretViaEcdh.secret);
    expect(secretViaRegistration.app).toEqual(app);
  });
});
