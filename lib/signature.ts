import { stringToU8a, u8aWrapBytes } from '@polkadot/util';
import { cryptoWaitReady, signatureVerify } from '@polkadot/util-crypto';

/**
 * Verifies a raw message signature. Browser extensions sign `<Bytes>message</Bytes>`, while
 * other signers may sign the bare message, so either form is accepted.
 */
export async function verifyMessageSignature(
  message: string,
  signature: `0x${string}`,
  address: string,
): Promise<boolean> {
  await cryptoWaitReady();
  const raw = stringToU8a(message);
  const candidates = [u8aWrapBytes(raw), raw];
  return candidates.some((data) => {
    try {
      return signatureVerify(data, signature, address).isValid;
    } catch {
      return false;
    }
  });
}
