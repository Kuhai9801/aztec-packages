import { Grumpkin } from '@aztec/foundation/crypto/grumpkin';
import { poseidon2Hash } from '@aztec/foundation/crypto/poseidon';
import { type Fq, Fr } from '@aztec/foundation/curves/bn254';
import type { Point } from '@aztec/foundation/curves/grumpkin';

import { z } from 'zod';

import { AztecAddress } from '../aztec-address/index.js';
import type { CompleteAddress } from '../contract/complete_address.js';
import { computeAddressSecret, computePreaddress } from '../keys/derivation.js';

/**
 * Extended directional application tagging secret used for log tagging.
 *
 * "Extended" because it bundles the directional app tagging secret with the app (contract) address. This bundling was
 * done because where this type is used we commonly need access to both the secret and the address.
 *
 * "Directional" because the derived secret is bound to the recipient address: A→B differs from B→A even with the same
 * participants and app.
 *
 * Note: It's a bit unfortunate that this type resides in `stdlib` as the rest of the tagging functionality resides in
 * `pxe/src/tagging`. We need to use this type in `PreTag` that in turn is used by other types in stdlib hence there
 * doesn't seem to be a good way around this.
 */
export class ExtendedDirectionalAppTaggingSecret {
  constructor(
    public readonly secret: Fr,
    public readonly app: AztecAddress,
  ) {}

  /**
   * Derives an app-siloed, recipient-directional tagging secret from a shared tagging secret point.
   *
   * The point is obtained either via {@link computeSharedTaggingSecret} (an ECDH key exchange against a sender) or
   * registered directly as a pre-shared secret. Each secret point yields a distinct tagging secret per (app, recipient)
   * pair.
   *
   * @param taggingSecretPoint - The shared tagging secret point (ECDH output, or a directly registered pre-shared secret)
   * @param app - Contract address to silo the secret to
   * @param recipient - Recipient of the log. Defines the "direction of the secret".
   * @returns The secret that can be used along with an index to compute a tag to be included in a log.
   */
  static async compute(
    taggingSecretPoint: Point,
    app: AztecAddress,
    recipient: AztecAddress,
  ): Promise<ExtendedDirectionalAppTaggingSecret> {
    const appTaggingSecret = await poseidon2Hash([taggingSecretPoint.x, taggingSecretPoint.y, app]);
    const directionalAppTaggingSecret = await poseidon2Hash([appTaggingSecret, recipient]);

    return new ExtendedDirectionalAppTaggingSecret(directionalAppTaggingSecret, app);
  }

  toString(): string {
    return `${this.secret.toString()}:${this.app.toString()}`;
  }

  static fromString(str: string): ExtendedDirectionalAppTaggingSecret {
    const [secretStr, appStr] = str.split(':');
    return new ExtendedDirectionalAppTaggingSecret(Fr.fromString(secretStr), AztecAddress.fromString(appStr));
  }
}

/**
 * Computes the shared tagging secret point between a local address (i.e. one for which the privacy keys are known) and
 * an external one via a Diffie-Hellman key exchange.
 *
 * Returns undefined if `externalAddress` is an invalid address.
 */
export async function computeSharedTaggingSecret(
  localAddress: CompleteAddress,
  localIvsk: Fq,
  externalAddress: AztecAddress,
): Promise<Point | undefined> {
  // An invalid address has no corresponding address point
  if (!(await externalAddress.isValid())) {
    return undefined;
  }

  const externalAddressPoint = await externalAddress.toAddressPoint();

  const localPreaddress = await computePreaddress(await localAddress.publicKeys.hash(), localAddress.partialAddress);
  const localAddressSecret = await computeAddressSecret(localPreaddress, localIvsk);

  // For a given local address A and external address B, the shared tagging secret S is (h_A + ivsk_A) * Addr_Point_B
  // (conceptually, in reality we don't use h_A + ivsk_A directly but rather the actual address secret, which is the
  // same but with an optional sign adjustment to prevent A's address point from having a negative y-coordinate).
  return Grumpkin.mul(externalAddressPoint, localAddressSecret);
}

export const ExtendedDirectionalAppTaggingSecretSchema = z.object({
  secret: Fr.schema,
  app: AztecAddress.schema,
});
