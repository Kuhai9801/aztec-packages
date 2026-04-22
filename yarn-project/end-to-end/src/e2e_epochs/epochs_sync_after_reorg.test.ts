import { type Archiver, RpcSyncArchiver, createRpcSyncArchiver } from '@aztec/archiver';
import type { AztecNodeService } from '@aztec/aztec-node';
import type { Logger } from '@aztec/aztec.js/log';
import { CheckpointNumber } from '@aztec/foundation/branded-types';
import { executeTimeout } from '@aztec/foundation/timer';
import type { AztecNode } from '@aztec/stdlib/interfaces/client';

import { jest } from '@jest/globals';

import type { EndToEndContext } from '../fixtures/utils.js';
import { EpochsTestContext } from './epochs_test.js';

jest.setTimeout(1000 * 60 * 10);

describe('e2e_epochs/epochs_sync_after_reorg', () => {
  let context: EndToEndContext;
  let logger: Logger;

  let L2_SLOT_DURATION_IN_S: number;

  let test: EpochsTestContext;
  let primaryNode: AztecNode;
  let rpcSyncArchiver: RpcSyncArchiver;

  beforeEach(async () => {
    test = await EpochsTestContext.setup({ startProverNode: false, enableProposerPipelining: true }); // no prover!
    ({ context, logger } = test);
    ({ L2_SLOT_DURATION_IN_S } = test);

    // Spin up an RpcSyncArchiver pointed at the primary node as soon as the nodes
    // are live, so we can assert that it follows along at every checkpoint-number assertion.
    primaryNode = context.aztecNode;
    rpcSyncArchiver = await createRpcSyncArchiverFromPrimary(primaryNode);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rpcSyncArchiver?.stop();
    await test.teardown();
  });

  // Regression for https://github.com/AztecProtocol/aztec-packages/issues/12206
  it('new node can sync world-state after unpruned reorg', async () => {
    // Wait until there are a few checkpoints in there
    // With pipelining, each checkpoint takes ~2 L2 slots (the sequencer must wait for
    // the L1 tx of the previous checkpoint to land before it can build the next one).
    await test.waitUntilCheckpointNumber(CheckpointNumber(5), L2_SLOT_DURATION_IN_S * 12 + 30);
    await assertRpcSyncArchiverAtCheckpoint(CheckpointNumber(5));

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
   * Triggers an immediate sync on the RpcSyncArchiver and asserts that its checkpointed tip is at
   * least the given checkpoint. We compare on the `checkpointed` tip (not `proposed`) because the
   * primary keeps producing blocks and the `proposed` tip can drift by one between the two calls.
   */
  async function assertRpcSyncArchiverAtCheckpoint(checkpoint: CheckpointNumber) {
    await rpcSyncArchiver.syncImmediate();
    const [primaryTips, followerTips] = await Promise.all([primaryNode.getL2Tips(), rpcSyncArchiver.getL2Tips()]);
    expect(followerTips.checkpointed.checkpoint.number).toBeGreaterThanOrEqual(checkpoint);
    expect(followerTips.checkpointed.block.number).toEqual(primaryTips.checkpointed.block.number);
    expect(followerTips.checkpointed.block.hash).toEqual(primaryTips.checkpointed.block.hash);
  }

  /**
   * Creates an RpcSyncArchiver pointed at the given primary node, reusing the primary archiver's
   * L1 constants and addresses (the RPC-sync archiver does not read L1 on its own). The source
   * passed to the factory is the `AztecNode` itself, proving the subset relationship expressed by
   * `RpcSyncArchiverSource`.
   */
  async function createRpcSyncArchiverFromPrimary(primary: AztecNode): Promise<RpcSyncArchiver> {
    // L1 constants and addresses are not part of the `AztecNode` interface, so we reach into the
    // primary's underlying archiver to obtain them for test wiring.
    const primaryArchiver = (primary as AztecNodeService).getBlockSource() as Archiver;
    const [l1Constants, genesisValues, rollupAddress, registryAddress] = await Promise.all([
      primaryArchiver.getL1Constants(),
      primaryArchiver.getGenesisValues(),
      primaryArchiver.getRollupAddress(),
      primaryArchiver.getRegistryAddress(),
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
    return createRpcSyncArchiver(
      followerConfig,
      primary,
      { ...l1Constants, genesisArchiveRoot: genesisValues.genesisArchiveRoot },
      {},
      { blockUntilSync: false },
    );
  }
});
