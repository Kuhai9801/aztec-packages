import { type Archiver, RpcSyncArchiver, createRpcSyncArchiver } from '@aztec/archiver';
import type { AztecNodeService } from '@aztec/aztec-node';
import type { Logger } from '@aztec/aztec.js/log';
import { CheckpointNumber } from '@aztec/foundation/branded-types';
import { executeTimeout } from '@aztec/foundation/timer';

import { jest } from '@jest/globals';

import type { EndToEndContext } from '../fixtures/utils.js';
import { EpochsTestContext } from './epochs_test.js';

jest.setTimeout(1000 * 60 * 10);

describe('e2e_epochs/epochs_sync_after_reorg', () => {
  let context: EndToEndContext;
  let logger: Logger;

  let L2_SLOT_DURATION_IN_S: number;

  let test: EpochsTestContext;

  beforeEach(async () => {
    test = await EpochsTestContext.setup({ startProverNode: false, enableProposerPipelining: true }); // no prover!
    ({ context, logger } = test);
    ({ L2_SLOT_DURATION_IN_S } = test);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await test.teardown();
  });

  // Regression for https://github.com/AztecProtocol/aztec-packages/issues/12206
  it('new node can sync world-state after unpruned reorg', async () => {
    // Wait until there are a few checkpoints in there
    // With pipelining, each checkpoint takes ~2 L2 slots (the sequencer must wait for
    // the L1 tx of the previous checkpoint to land before it can build the next one).
    await test.waitUntilCheckpointNumber(CheckpointNumber(5), L2_SLOT_DURATION_IN_S * 12 + 30);

    // Before stopping the node, verify that an RpcSyncArchiver can sync from the primary archiver
    // and ends up with tips matching the primary. This exercises the same non-L1 sync path that a
    // light read-only node would use in production.
    const primaryArchiver = (context.aztecNode as AztecNodeService).getBlockSource() as Archiver;
    const rpcSyncArchiver = await createRpcSyncArchiverFromPrimary(primaryArchiver);
    try {
      const [primaryTips, followerTips] = await Promise.all([primaryArchiver.getL2Tips(), rpcSyncArchiver.getL2Tips()]);
      expect(followerTips.checkpointed.block.number).toEqual(primaryTips.checkpointed.block.number);
      expect(followerTips.checkpointed.block.hash).toEqual(primaryTips.checkpointed.block.hash);
      expect(followerTips.proposed.number).toEqual(primaryTips.proposed.number);
      expect(followerTips.proposed.hash).toEqual(primaryTips.proposed.hash);
    } finally {
      await rpcSyncArchiver.stop();
    }

    // Stop the node generating blocks
    logger.warn(`Stopping the main node`);
    await (context.aztecNode as AztecNodeService).stop();

    // Wait for an extra epoch, so a reorg would invalidate these blocks
    await test.waitUntilEpochStarts(2);

    // Add a new node and watch it sync
    // We add a timeout since the archiver never finishes syncing and this promise does not resolve is the bug is not fixed
    logger.warn(`Syncing new node`);
    const node = await executeTimeout(() => test.createNonValidatorNode(), 10_000, `new node sync`);
    expect(await node.getBlockNumber()).toEqual(0);
    logger.info(`Test succeeded`);
  });

  /**
   * Creates an RpcSyncArchiver pointed at the given primary archiver, reusing its L1 constants
   * and addresses (the RPC-sync archiver does not read L1 on its own).
   */
  async function createRpcSyncArchiverFromPrimary(primary: Archiver): Promise<RpcSyncArchiver> {
    const [l1Constants, genesisValues, rollupAddress, registryAddress] = await Promise.all([
      primary.getL1Constants(),
      primary.getGenesisValues(),
      primary.getRollupAddress(),
      primary.getRegistryAddress(),
    ]);
    const followerConfig = {
      ...test.context.config,
      dataDirectory: `${test.context.config.dataDirectory}/rpc-sync-follower`,
      l1Contracts: {
        ...test.context.config.l1Contracts,
        rollupAddress,
        registryAddress,
      },
    };
    return createRpcSyncArchiver(followerConfig, primary, {
      ...l1Constants,
      genesisArchiveRoot: genesisValues.genesisArchiveRoot,
    });
  }
});
