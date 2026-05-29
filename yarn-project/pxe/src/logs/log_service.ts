import type { BlockNumber } from '@aztec/foundation/branded-types';
import type { GrumpkinScalar, Point } from '@aztec/foundation/curves/grumpkin';
import { type Logger, type LoggerBindings, createLogger } from '@aztec/foundation/log';
import type { KeyStore } from '@aztec/key-store';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import type { BlockHash, L2TipsProvider } from '@aztec/stdlib/block';
import type { CompleteAddress } from '@aztec/stdlib/contract';
import type { AztecNode } from '@aztec/stdlib/interfaces/server';
import {
  ExtendedDirectionalAppTaggingSecret,
  PendingTaggedLog,
  SiloedTag,
  type TxScopedL2Log,
  computeSharedTaggingSecret,
} from '@aztec/stdlib/logs';
import type { BlockHeader } from '@aztec/stdlib/tx';

import {
  type LogRetrievalRequest,
  LogSource,
} from '../contract_function_simulator/noir-structs/log_retrieval_request.js';
import { LogRetrievalResponse } from '../contract_function_simulator/noir-structs/log_retrieval_response.js';
import { AddressStore } from '../storage/address_store/address_store.js';
import type { RecipientTaggingStore } from '../storage/tagging_store/recipient_tagging_store.js';
import type { TaggingSecretSourcesStore } from '../storage/tagging_store/tagging_secret_sources_store.js';
import {
  getAllPrivateLogsByTags,
  getAllPublicLogsByTagsFromContract,
  syncTaggedPrivateLogs,
} from '../tagging/index.js';

export class LogService {
  private log: Logger;

  constructor(
    private readonly aztecNode: AztecNode,
    private readonly anchorBlockHeader: BlockHeader,
    private readonly l2TipsStore: L2TipsProvider,
    private readonly keyStore: KeyStore,
    private readonly recipientTaggingStore: RecipientTaggingStore,
    private readonly taggingSecretSourcesStore: TaggingSecretSourcesStore,
    private readonly addressStore: AddressStore,
    private readonly jobId: string,
    bindings?: LoggerBindings,
  ) {
    this.log = createLogger('pxe:log_service', bindings);
  }

  /** Fetches all logs matching each request's tag, returning an array of log arrays (one per request). */
  public async fetchLogsByTag(
    contractAddress: AztecAddress,
    logRetrievalRequests: LogRetrievalRequest[],
  ): Promise<LogRetrievalResponse[][]> {
    for (const request of logRetrievalRequests) {
      if (!contractAddress.equals(request.contractAddress)) {
        throw new Error(`Got a log retrieval request from ${request.contractAddress}, expected ${contractAddress}`);
      }
    }

    if (logRetrievalRequests.length === 0) {
      return [];
    }

    const anchorBlockHash = await this.anchorBlockHeader.hash();

    const [publicLogsPerTag, privateLogsPerTag] = await Promise.all([
      this.#fetchPublicLogs(contractAddress, logRetrievalRequests, anchorBlockHash),
      this.#fetchPrivateLogs(logRetrievalRequests, anchorBlockHash),
    ]);

    return logRetrievalRequests.map((request, i) => [
      ...this.#extractLogs(publicLogsPerTag[i], request.fromBlock, request.toBlock),
      ...this.#extractLogs(privateLogsPerTag[i], request.fromBlock, request.toBlock),
    ]);
  }

  async #fetchPublicLogs(
    contractAddress: AztecAddress,
    requests: LogRetrievalRequest[],
    anchorBlockHash: BlockHash,
  ): Promise<TxScopedL2Log[][]> {
    const indices = requests.flatMap((r, i) => (r.source !== LogSource.PRIVATE ? [i] : []));
    if (indices.length === 0) {
      return requests.map(() => []);
    }

    const results = await getAllPublicLogsByTagsFromContract(
      this.aztecNode,
      contractAddress,
      indices.map(i => requests[i].tag),
      anchorBlockHash,
    );

    const logsPerTag: TxScopedL2Log[][] = requests.map(() => []);
    indices.forEach((originalIdx, resultIdx) => {
      logsPerTag[originalIdx] = results[resultIdx];
    });
    return logsPerTag;
  }

  async #fetchPrivateLogs(requests: LogRetrievalRequest[], anchorBlockHash: BlockHash): Promise<TxScopedL2Log[][]> {
    const indices = requests.flatMap((r, i) => (r.source !== LogSource.PUBLIC ? [i] : []));
    if (indices.length === 0) {
      return requests.map(() => []);
    }

    const siloedTags = await Promise.all(
      indices.map(i => SiloedTag.computeFromTagAndApp(requests[i].tag, requests[i].contractAddress)),
    );

    const results = await getAllPrivateLogsByTags(this.aztecNode, siloedTags, anchorBlockHash);

    const logsPerTag: TxScopedL2Log[][] = requests.map(() => []);
    indices.forEach((originalIdx, resultIdx) => {
      logsPerTag[originalIdx] = results[resultIdx];
    });
    return logsPerTag;
  }

  #extractLogs(logsForTag: TxScopedL2Log[], fromBlock?: BlockNumber, toBlock?: BlockNumber): LogRetrievalResponse[] {
    // TODO(F-650): push the block range filter down to the node query instead of filtering in memory.
    const filtered =
      fromBlock !== undefined || toBlock !== undefined
        ? logsForTag.filter(
            log =>
              (fromBlock === undefined || log.blockNumber >= fromBlock) &&
              (toBlock === undefined || log.blockNumber < toBlock),
          )
        : logsForTag;

    return filtered.map(
      scopedLog =>
        new LogRetrievalResponse(
          scopedLog.logData.slice(1), // Skip the tag
          scopedLog.txHash,
          scopedLog.noteHashes,
          scopedLog.firstNullifier,
        ),
    );
  }

  public async fetchTaggedLogs(contractAddress: AztecAddress, recipient: AztecAddress): Promise<PendingTaggedLog[]> {
    this.log.verbose(
      `Fetching tagged logs for contract ${contractAddress.toString()} and recipient ${recipient.toString()}`,
    );

    // Gate on knowing the recipient's complete address and ivsk, as otherwise we'll be unable to do ECDH and decrypt
    // any messages received in logs.
    const recipientCompleteAddress = await this.addressStore.getCompleteAddress(recipient);
    if (!recipientCompleteAddress || !(await this.keyStore.hasAccount(recipient))) {
      this.log.warn(`Skipping tagged log retrieval for ${recipient.toString()} due to unknown address preimage`);
      return [];
    }
    const recipientIvsk = await this.keyStore.getMasterIncomingViewingSecretKey(recipient);

    const l2Tips = await this.l2TipsStore.getL2Tips();

    // Get all secrets for this recipient: one per sender (derived via ECDH), plus any pre-shared secrets registered
    // directly for this recipient.
    const combinedSecrets = await Promise.all(
      [
        ...(await this.#getSecretsForSenders(recipientCompleteAddress, recipientIvsk)),
        ...(await this.taggingSecretSourcesStore.getSharedSecrets(recipient)),
      ].map(secret => ExtendedDirectionalAppTaggingSecret.compute(secret, contractAddress, recipient)),
    );

    // These sources can overlap (a sender that is also a PXE account, or a pre-shared secret that coincides with a
    // sender-derived one), so we deduplicate the combined set.
    const secrets = Array.from(new Map(combinedSecrets.map(secret => [secret.toString(), secret])).values());

    const logs = await syncTaggedPrivateLogs(
      secrets,
      this.aztecNode,
      this.recipientTaggingStore,
      this.anchorBlockHeader,
      l2Tips.finalized.block.number,
      this.jobId,
    );

    return logs.map(
      scopedLog =>
        new PendingTaggedLog(scopedLog.logData, scopedLog.txHash, scopedLog.noteHashes, scopedLog.firstNullifier),
    );
  }

  async #getSecretsForSenders(
    recipientCompleteAddress: CompleteAddress,
    recipientIvsk: GrumpkinScalar,
  ): Promise<Point[]> {
    // We implicitly add all PXE accounts as senders, this helps us decrypt tags on notes that we send to ourselves
    // (recipient = us, sender = us).
    const allSenders = [...(await this.taggingSecretSourcesStore.getSenders()), ...(await this.keyStore.getAccounts())];

    return Promise.all(
      allSenders.map(async sender => {
        const taggingSecretPoint = await computeSharedTaggingSecret(recipientCompleteAddress, recipientIvsk, sender);

        if (!taggingSecretPoint) {
          // Note that all senders originate from either the TaggingSecretSourcesStore or the KeyStore.
          throw new Error(
            `Failed to compute a tagging secret for sender ${sender} - this implies this is an invalid address, which should not happen as they have been previously registered in PXE.`,
          );
        }

        return taggingSecretPoint;
      }),
    );
  }
}
