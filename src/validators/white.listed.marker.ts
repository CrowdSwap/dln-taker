import { OrderData } from "@debridge-finance/pmm-client/src/order";
import { helpers } from "@debridge-finance/solana-utils";

import { ExecutorConfig } from "../config";

import { ValidatorContext } from "./order.validator";
import {OrderValidatorInterface} from "./order.validator.interface";
import {ChainId} from "@debridge-finance/pmm-client";
import {convertAddressToBuffer} from "../utils/convert.address.to.buffer";

/**
 * Checks if the address who placed the order on the source chain is in the whitelist. This validator is useful to filter out orders placed by the trusted parties.
 */
export class WhiteListedMarker extends OrderValidatorInterface{

  private addressesBuffer: Uint8Array[];

  constructor(private readonly addresses: string[]) {
    super();
  }

  init(chainId: ChainId): Promise<void> {
    super.chainId = chainId;
    this.addressesBuffer = this.addresses.map((address) => convertAddressToBuffer(chainId, address));
    return Promise.resolve();
  }

  validate(order: OrderData, config: ExecutorConfig, context: ValidatorContext): Promise<boolean> {
    const logger = context.logger.child({ validator: "WhiteListedMarker" });
    const result = this.addressesBuffer.some(address => buffersAreEqual(order.maker, address))

    const maker = helpers.bufferToHex(Buffer.from(order.maker));
    logger.info(`approve status: ${result}, giveToken ${maker}`);
    return Promise.resolve(result);
  }
}
