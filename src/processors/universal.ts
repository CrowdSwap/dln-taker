import {
  buffersAreEqual,
  calculateExpectedTakeAmount,
  ChainEngine,
  ChainId,
  evm,
  getEngineByChainId,
  OrderData,
  OrderState,
  pickReserveToken,
  tokenAddressToString,
  PreswapFulfillOrderPayload,
  EvmChains,
  ClientError,
  ClientErrorType
} from "@debridge-finance/dln-client";
import { SwapConnectorRequest, SwapConnectorResult } from "@debridge-finance/dln-client/dist/types/swapConnector/swap.connector";
import BigNumber from "bignumber.js";
import { Logger } from "pino";
import Web3 from "web3";

import { OrderInfoStatus } from "../enums/order.info.status";
import { IncomingOrderContext } from "../interfaces";
import { createClientLogger } from "../logger";
import { EvmProviderAdapter, Tx } from "../providers/evm.provider.adapter";
import { SolanaProviderAdapter } from "../providers/solana.provider.adapter";

import {
  BaseOrderProcessor,
  OrderProcessorContext,
  OrderProcessorInitContext,
  OrderProcessorInitializer,
} from "./base";
import { BatchUnlocker } from "./BatchUnlocker";
import { MempoolService } from "./mempool.service";
import { approveToken } from "./utils/approve";

// reasonable multiplier for gas estimated for the fulfill txn to define max
// gas we are willing to estimate
const EVM_FULFILL_GAS_MULTIPLIER = 1.25;

// reasonable multiplier for gas price to define max gas price we are willing to
// bump until
const EVM_FULFILL_GAS_PRICE_MULTIPLIER = 1.3;

export type UniversalProcessorParams = {
  /**
   * desired profitability. Setting a higher value would prevent executor from fulfilling most orders because
   * the deBridge app and the API suggest users placing orders with as much margin as 4bps
   */
  minProfitabilityBps: number;
  /**
   * Mempool: max amount of seconds to wait before second attempt to process an order; default: 60s
   */
  mempoolInterval: number;
  /**
   * Mempool: amount of seconds to add to the max amount of seconds on each subsequent attempt; default: 30s
   */
  mempoolMaxDelayStep: number;
  /**
   * Number of orders (per every chain where orders are coming from and to) to accumulate to unlock them in batches
   *     Min: 1; max: 10, default: 10.
   *     This means that the executor would accumulate orders (that were fulfilled successfully) rather then unlock
   *     them on the go, and would send a batch of unlock commands every time enough orders were fulfilled, dramatically
   *     reducing the cost of the unlock command execution.
   *     You can set a lesser value to unlock orders more frequently, however please note that this value directly
   *     affects order profitability because the deBridge app and the API reserves the cost of unlock in the order's margin,
   *     assuming that the order would be unlocked in a batch of size=10. Reducing the batch size to a lower value increases
   *     your unlock costs and thus reduces order profitability, making them unprofitable most of the time.
   */
  batchUnlockSize: number;
};

class UniversalProcessor extends BaseOrderProcessor {
  private mempoolService: MempoolService;
  private priorityQueue = new Set<string>(); // queue of orderid for processing created order
  private queue = new Set<string>(); // queue of orderid for retry processing order
  private incomingOrdersMap = new Map<string, IncomingOrderContext>(); // key orderid, contains incoming order from order feed
  private isLocked: boolean = false;
  private batchUnlocker: BatchUnlocker;

  private params: UniversalProcessorParams = {
    minProfitabilityBps: 4,
    mempoolInterval: 60,
    mempoolMaxDelayStep: 30,
    batchUnlockSize: 10,
  };

  constructor(params?: Partial<UniversalProcessorParams>) {
    super();
    const batchUnlockSize = params?.batchUnlockSize;
    if (
      batchUnlockSize !== undefined &&
      (batchUnlockSize > 10 || batchUnlockSize < 1)
    ) {
      throw new Error("batchUnlockSize should be in [1, 10]");
    }
    Object.assign(this.params, params || {});
  }

  async init(
    chainId: ChainId,
    context: OrderProcessorInitContext
  ): Promise<void> {
    this.chainId = chainId;
    this.takeChain = context.takeChain;

    const logger = context.logger.child({
      processor: "universal",
      takeChainId: chainId,
    });

    this.batchUnlocker = new BatchUnlocker(
      logger,
      this.takeChain,
      this.params.batchUnlockSize
    );

    this.mempoolService = new MempoolService(
      logger.child({ takeChainId: chainId }),
      this.process.bind(this),
      this.params.mempoolInterval
    );

    if (chainId !== ChainId.Solana) {
      const tokens: string[] = [];
      context.buckets.forEach((bucket) => {
        const tokensFromBucket = bucket.findTokens(this.chainId) || [];
        tokensFromBucket.forEach((token) => {
          tokens.push(tokenAddressToString(this.chainId, token));
        });
      });

      const client = this.takeChain.client as evm.PmmEvmClient;
      for (const token of tokens) {
        await approveToken(
          chainId,
          token,
          client.getContractAddress(
            chainId,
            evm.ServiceType.CrosschainForwarder
          ),
          this.takeChain.fulfullProvider as EvmProviderAdapter,
          logger
        );

        await approveToken(
          chainId,
          token,
          client.getContractAddress(chainId, evm.ServiceType.Destination),
          this.takeChain.fulfullProvider as EvmProviderAdapter,
          logger
        );
      }
    }
  }

  async process(params: IncomingOrderContext): Promise<void> {
    const { context, orderInfo } = params;
    const { orderId, type, order } = orderInfo;

    params.context.logger = context.logger.child({
      processor: "universal",
      orderId,
    });

    switch (type) {
      case OrderInfoStatus.ArchivalCreated:
      case OrderInfoStatus.Created: {
        return this.tryProcess(params);
      }
      case OrderInfoStatus.ArchivalFulfilled: {
        this.batchUnlocker.unlockOrder(orderId, order!, context);
        return;
      }
      case OrderInfoStatus.Cancelled: {
        this.queue.delete(orderId);
        this.priorityQueue.delete(orderId);
        this.incomingOrdersMap.delete(orderId);
        this.mempoolService.delete(orderId);
        context.logger.debug(`deleted from queues`);
        return;
      }
      case OrderInfoStatus.Fulfilled: {
        this.queue.delete(orderId);
        this.priorityQueue.delete(orderId);
        this.incomingOrdersMap.delete(orderId);
        this.mempoolService.delete(orderId);
        context.logger.debug(`deleted from queues`);
        this.batchUnlocker.unlockOrder(orderId, order!, context);
        return;
      }
      case OrderInfoStatus.Other:
      default: {
        context.logger.error(
          `status=${OrderInfoStatus[type]} not implemented, skipping`
        );
        return;
      }
    }
  }

  private async tryProcess(params: IncomingOrderContext): Promise<void> {
    const { context, orderInfo } = params;
    const { orderId } = orderInfo;

    // already processing an order
    if (this.isLocked) {
      context.logger.debug(
        `Processor is currently processing an order, postponing`
      );

      switch (params.orderInfo.type) {
        case OrderInfoStatus.ArchivalCreated: {
          this.queue.add(orderId);
          context.logger.debug(`postponed to secondary queue`);
          break;
        }
        case OrderInfoStatus.Created: {
          this.priorityQueue.add(orderId);
          context.logger.debug(`postponed to primary queue`);
          break;
        }
        default:
          throw new Error(
            `Unexpected order status: ${OrderInfoStatus[params.orderInfo.type]}`
          );
      }
      this.incomingOrdersMap.set(orderId, params);
      return;
    }

    // process this order
    this.isLocked = true;
    try {
      await this.processOrder(params);
    } catch (e) {
      context.logger.error(`processing order failed with error: ${e}`);
      context.logger.error(e);
    }
    this.isLocked = false;

    // forward to the next order
    // TODO try to get rid of recursion here. Use setInterval?
    const nextOrder = this.pickNextOrder();
    if (nextOrder) {
      this.tryProcess(nextOrder);
    }
  }

  private pickNextOrder() {
    const nextOrderId =
      this.priorityQueue.values().next().value ||
      this.queue.values().next().value;

    if (nextOrderId) {
      const order = this.incomingOrdersMap.get(nextOrderId);

      this.priorityQueue.delete(nextOrderId);
      this.queue.delete(nextOrderId);
      this.incomingOrdersMap.delete(nextOrderId);

      return order;
    }
  }

  private async processOrder(
    params: IncomingOrderContext
  ): Promise<void | never> {
    const { orderInfo, context } = params;
    const { orderId, order } = orderInfo;
    const logger = params.context.logger;

    if (!order || !orderId) {
      logger.error("order is empty, should not happen");
      return;
    }

    const bucket = context.config.buckets.find(
      (bucket) =>
        bucket.isOneOf(order.give.chainId, order.give.tokenAddress) &&
        bucket.findFirstToken(order.take.chainId) !== undefined
    );
    if (bucket === undefined) {
      logger.info(
        `no bucket found to cover order's give token: ${tokenAddressToString(
          order.give.chainId,
          order.give.tokenAddress
        )}, skipping`
      );
      return;
    }

    // validate that order is not fullfilled
    const takeOrderStatus = await context.config.client.getTakeOrderStatus(
      orderId,
      params.orderInfo.order!.take.chainId,
      { web3: this.takeChain.fulfullProvider.connection as Web3 }
    );
    if (
      takeOrderStatus?.status !== OrderState.NotSet &&
      takeOrderStatus?.status !== undefined
    ) {
      logger.info("order is already handled on the give chain, skipping");
      return;
    }

    // validate that order is created
    const giveOrderStatus = await context.config.client.getGiveOrderStatus(
      params.orderInfo.orderId,
      params.orderInfo.order!.give.chainId,
      { web3: context.giveChain.fulfullProvider.connection as Web3 }
    );
    if (giveOrderStatus?.status !== OrderState.Created) {
      logger.info("inexistent order, skipping");
      return;
    }

    // perform rough estimation: assuming order.give.amount is what we need on balance
    const pickedBucket = pickReserveToken(order, context.config.buckets);
    const [reserveSrcTokenDecimals, reserveDstTokenDecimals] = await Promise.all([
      context.config.client.getDecimals(order.give.chainId, pickedBucket.reserveSrcToken, context.giveChain.fulfullProvider.connection as Web3),
      context.config.client.getDecimals(order.take.chainId, pickedBucket.reserveDstToken, this.takeChain.fulfullProvider.connection as Web3),
    ]);

    // reserveSrcToken is eq to reserveDstToken, but need to sync decimals
    let roughReserveDstAmount = BigNumber(order.give.amount.toString()).div(BigNumber(10).pow(reserveSrcTokenDecimals - reserveDstTokenDecimals)).integerValue();
    logger.debug(`expressed order give amount (${order.give.amount.toString()}) in reserve dst token ${tokenAddressToString(order.take.chainId, pickedBucket.reserveDstToken)} @ ${ChainId[order.take.chainId]}: ${roughReserveDstAmount.toString()} `)

    const accountReserveBalance =
      await this.takeChain.fulfullProvider.getBalance(pickedBucket.reserveDstToken);
    if (new BigNumber(accountReserveBalance).lt(roughReserveDstAmount)) {
      logger.info(
        `not enough reserve token on balance: ${accountReserveBalance} actual, but expected ${roughReserveDstAmount}; postponing it to the mempool`
      );
      this.mempoolService.addOrder(params);
      return;
    }
    logger.debug(`enough balance (${accountReserveBalance.toString()}) to cover order (${roughReserveDstAmount.toString()})`)

    let evmFulfillGasLimit: number | undefined;
    let evmFulfillCappedGasPrice: BigNumber | undefined;
    let preswapTx: SwapConnectorResult<EvmChains> | undefined;
    if (getEngineByChainId(this.takeChain.chain) == ChainEngine.EVM) {
      // when performing estimation, we need to set some slippage for the swap. Let's set it reasonably high, because
      // we don't care right now

      const reasonableDummySlippage = 500; // 5%
      try {
        const fulfillTx = await this.createOrderFullfillTx<ChainId.Ethereum>(
          orderId,
          order,
          pickedBucket.reserveDstToken,
          roughReserveDstAmount.toString(),
          reasonableDummySlippage,
          undefined,
          context,
          logger
        );

        //
        // predicting gas price cap
        //
        const currentGasPrice = BigNumber(
          await (this.takeChain.fulfullProvider.connection as Web3).eth.getGasPrice()
        );
        evmFulfillCappedGasPrice = currentGasPrice
          .multipliedBy(EVM_FULFILL_GAS_PRICE_MULTIPLIER)
          .integerValue();
        logger.debug(`capped gas price: ${evmFulfillCappedGasPrice.toFixed(0)}`)

        //
        // predicting gas limit
        //
        evmFulfillGasLimit = await (this.takeChain.fulfullProvider.connection as Web3).eth.estimateGas({
          to: fulfillTx.tx.to,
          data: fulfillTx.tx.data,
          value: fulfillTx.tx.value.toString(),
        });
        logger.debug(`estimated gas needed for the fulfill tx with roughly estimated reserve amount: ${evmFulfillGasLimit} gas units`);

        evmFulfillGasLimit = Math.round(evmFulfillGasLimit * EVM_FULFILL_GAS_MULTIPLIER);
        logger.debug(`declared gas limit for the fulfill tx to be used in further estimations: ${evmFulfillGasLimit} gas units`);

        //
        // this needed to preserve swap routes (1inch specific)
        //
        preswapTx = fulfillTx.preswapTx;
      }
      catch (e) {
        if (e instanceof ClientError) {
          logger.info(`preliminary fullfil tx estimation failed: ${e}, reason: ${e.type}; postponing to the mempool`)
        }
        else {
          logger.error(`unable to estimate preliminary fullfil tx: ${e}; this can be because the order is not profitable; postponing to the mempool`);
          logger.error(e);
        }
        this.mempoolService.addOrder(params);
        return;
      }
    }

    const batchSize =
      order.give.chainId === ChainId.Solana ||
      order.take.chainId === ChainId.Solana
        ? null
        : this.params.batchUnlockSize;

    const {
      reserveDstToken,
      requiredReserveDstAmount,
      isProfitable,
      reserveToTakeSlippageBps,
    } = await calculateExpectedTakeAmount(
      order,
      this.params.minProfitabilityBps,
      {
        client: context.config.client,
        giveConnection: context.giveChain.fulfullProvider.connection as Web3,
        takeConnection: this.takeChain.fulfullProvider.connection as Web3,
        priceTokenService: context.config.tokenPriceService,
        buckets: context.config.buckets,
        swapConnector: context.config.swapConnector,
        logger: createClientLogger(logger),
        batchSize,
        evmFulfillGasLimit,
        evmFulfillCappedGasPrice: evmFulfillCappedGasPrice ? BigInt(evmFulfillCappedGasPrice.integerValue().toString()) : undefined,
        swapEstimationPreference: preswapTx
      }
    );


    if (isProfitable) {
      logger.info("order is profitable")
    }
    else {
      logger.info("order is not profitable, postponing it to the mempool");
      this.mempoolService.addOrder(params);
      return;
    }

    if (!buffersAreEqual(reserveDstToken, pickedBucket.reserveDstToken)) {
      logger.error(`internal error: \
dln-taker has picked ${tokenAddressToString(order.take.chainId, pickedBucket.reserveDstToken)} as reserve token, \
while calculateExpectedTakeAmount returned ${tokenAddressToString(order.take.chainId, reserveDstToken)}`);
      return;
    }

    // fulfill order
    const { tx: fulfillTx } = await this.createOrderFullfillTx(
      orderId,
      order,
      reserveDstToken,
      requiredReserveDstAmount,
      reserveToTakeSlippageBps,
      preswapTx,
      context,
      logger
    );
    if (getEngineByChainId(order.take.chainId) === ChainEngine.EVM) {
      try {
        const evmFulfillGas = await (this.takeChain.fulfullProvider.connection as Web3).eth.estimateGas(fulfillTx as Tx);
        logger.debug(`final fulfill tx gas estimation: ${evmFulfillGas}`)
        if (evmFulfillGas > evmFulfillGasLimit!) {
          logger.info(`final fulfill tx requires more gas units (${evmFulfillGas}) than it was declared during pre-estimation (${evmFulfillGasLimit}); postponing to the mempool `)
          // reprocess order after 5s delay, but no more than two times in a row
          const maxFastTrackAttempts = 2; // attempts
          const fastTrackDelay = 5; // seconds
          this.mempoolService.addOrder(params, params.attempts < maxFastTrackAttempts ? fastTrackDelay : undefined);
          return;
        }
      }
      catch (e) {
        logger.error(`unable to estimate fullfil tx: ${e}; postponing to the mempool`)
        logger.error(e);
        this.mempoolService.addOrder(params);
        return;
      }

      (fulfillTx as any as Tx).gas = evmFulfillGasLimit;
      (fulfillTx as any as Tx).cappedGasPrice = evmFulfillCappedGasPrice;
    }

    try {
      const txFulfill = await this.takeChain.fulfullProvider.sendTransaction(
        fulfillTx,
        { logger }
      );
      logger.info(`fulfill tx broadcasted, txhash: ${txFulfill}`);
    } catch (e) {
      logger.error(`fulfill transaction failed: ${e}`);
      logger.error(e);
      this.mempoolService.addOrder(params);
      return;
    }

    await this.waitIsOrderFulfilled(orderId, order, context, logger);
    logger.info(`order fulfilled: ${orderId}`)

    // unlocking
    this.batchUnlocker.unlockOrder(orderId, order, context);
  }

  private async createOrderFullfillTx<T extends ChainId>(
    orderId: string,
    order: OrderData,
    reserveDstToken: Uint8Array,
    reservedAmount: string,
    reserveToTakeSlippageBps: number | null,
    preferEstimation: SwapConnectorRequest['preferEstimation'] | undefined,
    context: OrderProcessorContext,
    logger: Logger
  ) {
    let fullFillTxPayload: PreswapFulfillOrderPayload<any> = {
      slippageBps: reserveToTakeSlippageBps || undefined,
      swapConnector: context.config.swapConnector,
      reservedAmount: reservedAmount,
      loggerInstance: createClientLogger(logger),
      preferEstimation
    }
    if (order.take.chainId === ChainId.Solana) {
      const wallet = (this.takeChain.fulfullProvider as SolanaProviderAdapter)
        .wallet.publicKey;
      const solanaFullFillTxPayload: PreswapFulfillOrderPayload<ChainId.Solana> = {
        taker: wallet
      }
      fullFillTxPayload = solanaFullFillTxPayload;
    } else {
      const evmfullFillTxPayload: PreswapFulfillOrderPayload<EvmChains> = {
        ...fullFillTxPayload,
        web3: this.takeChain.fulfullProvider.connection as Web3,
        permit: "0x",
        takerAddress: this.takeChain.fulfullProvider.address,
        unlockAuthority: this.takeChain.unlockProvider.address
      };
      fullFillTxPayload = evmfullFillTxPayload;
    }

    const fulfillTx = await context.config.client.preswapAndFulfillOrder<T>(
      order,
      orderId,
      reserveDstToken,
      fullFillTxPayload as PreswapFulfillOrderPayload<T>
    );
    logger.debug(`fulfillTx is created`);
    logger.debug(fulfillTx);
    return fulfillTx;
  }
}

export const universalProcessor = (
  params?: Partial<UniversalProcessorParams>
): OrderProcessorInitializer => {
  return async (chainId: ChainId, context: OrderProcessorInitContext) => {
    const processor = new UniversalProcessor(params);
    await processor.init(chainId, context);
    return processor;
  };
};