import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  ClientOptions,
  ReadContractParams,
  WriteContractParams,
} from './vm-client.types';
import { AnchorProvider, Program, BN } from '@coral-xyz/anchor';
import { UniversalSigner } from '../universal/universal.types';
import type { Wallet } from '@coral-xyz/anchor';
import { utils } from '@coral-xyz/anchor';
/**
 * Solana-compatible VM client for reading and writing SVM-based chains.
 */
export class SvmClient {
  private readonly connections: Connection[];
  private currentConnectionIndex = 0;

  constructor({ rpcUrls }: ClientOptions) {
    if (!rpcUrls || rpcUrls.length === 0) {
      throw new Error('At least one RPC URL must be provided');
    }

    this.connections = rpcUrls.map((url) => new Connection(url, 'confirmed'));
  }

  /**
   * Executes a function with automatic fallback to next RPC endpoint on failure
   */
  private async executeWithFallback<T>(
    operation: (connection: Connection) => Promise<T>,
    operationName = 'operation'
  ): Promise<T> {
    let lastError: Error | null = null;

    // Try each connection starting from current index
    for (let attempt = 0; attempt < this.connections.length; attempt++) {
      const connectionIndex =
        (this.currentConnectionIndex + attempt) % this.connections.length;
      const connection = this.connections[connectionIndex];

      try {
        const result = await operation(connection);
        // Success - update current connection index if we switched
        if (connectionIndex !== this.currentConnectionIndex) {
          //console.log(`Switched to RPC endpoint ${connectionIndex + 1}: ${this.rpcUrls[connectionIndex]}`);
          this.currentConnectionIndex = connectionIndex;
        }
        return result;
      } catch (error) {
        lastError = error as Error;
        //console.warn(`RPC endpoint ${connectionIndex + 1} failed for ${operationName}:`, error);

        // If this was our last attempt, throw the error
        if (attempt === this.connections.length - 1) {
          break;
        }

        // Wait a bit before trying next endpoint
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    throw new Error(
      `All RPC endpoints failed for ${operationName}. Last error: ${lastError?.message}`
    );
  }

  /** Build an AnchorProvider; if a signer is passed we wrap it, otherwise we give a no-op wallet. */
  private createProvider(
    connection: Connection,
    signer?: UniversalSigner
  ): AnchorProvider {
    let wallet: Wallet;

    if (signer) {
      const feePayerPk = new PublicKey(signer.account.address);
      wallet = {
        publicKey: feePayerPk,
        payer: signer.account as any,
        signTransaction: async <T extends Transaction | VersionedTransaction>(
          tx: T
        ): Promise<T> => tx,
        signAllTransactions: async <
          T extends Transaction | VersionedTransaction
        >(
          txs: T[]
        ): Promise<T[]> => txs,
      };
    } else {
      // dummy keypair + no-op sign
      const kp = Keypair.generate();
      wallet = {
        publicKey: kp.publicKey,
        payer: kp,
        signTransaction: async <T extends Transaction | VersionedTransaction>(
          tx: T
        ): Promise<T> => tx,
        signAllTransactions: async <
          T extends Transaction | VersionedTransaction
        >(
          txs: T[]
        ): Promise<T[]> => txs,
      };
    }

    return new AnchorProvider(connection, wallet, {
      preflightCommitment: 'confirmed',
    });
  }

  /**
   * Returns the balance (in lamports) of a Solana address.
   */
  async getBalance(address: string): Promise<bigint> {
    const pubkey = new PublicKey(address);
    const lamports = await this.executeWithFallback(
      (connection) => connection.getBalance(pubkey),
      'getBalance'
    );
    return BigInt(lamports);
  }
  /**
   * Reads a full program account using Anchor IDL.
   * `functionName` must match the account layout name in the IDL.
   */
  async readContract<T = unknown>({
    abi,
    functionName,
    args = [],
  }: ReadContractParams): Promise<T> {
    return this.executeWithFallback(async (connection) => {
      const provider = this.createProvider(connection);
      // Anchor v0.31 constructor no longer takes programId
      // Use the IDL's embedded metadata.address instead
      const program = new Program<typeof abi>(abi, provider);

      const pubkey = new PublicKey(args[0]);
      // Cast account namespace to any to allow dynamic string
      const accountNamespace = program.account as any;
      const account = await accountNamespace[functionName].fetch(pubkey);
      return account as T;
    }, 'readContract');
  }

  /**
   * Sends a Solana transaction using a smart contract instruction.
   */
  async writeContract({
    abi,
    signer,
    functionName,
    args = [],
    accounts = {},
    extraSigners = [],
  }: WriteContractParams): Promise<string> {
    // 1. Grab or build your RPC connection however your class manages it
    const connection = this.connections[this.currentConnectionIndex];

    // 2. Create an AnchorProvider
    const provider = this.createProvider(connection);

    // 3. Instantiate the program (Anchor v0.31 will infer programId from IDL.metadata.address)
    const program = new Program<typeof abi>(abi, provider);

    // 4. Convert any BigInt args into BN for Anchor
    const convertedArgs = args.map((arg) =>
      typeof arg === 'bigint' ? new BN(arg.toString()) : arg
    );

    // 5. Build the method call
    let builder =
      convertedArgs.length > 0
        ? (program.methods[functionName](...convertedArgs) as any)
        : (program.methods[functionName]() as any);

    if (Object.keys(accounts).length > 0) {
      builder = builder.accounts(accounts);
    }

    // 6. Get the actual instruction
    const instruction = await builder.instruction();

    // 7. Send it and return the tx signature
    return this.sendTransaction({
      instruction,
      signer,
      extraSigners,
    });
  }

  /**
   * Sends a set of instructions as a manually-signed Solana transaction.
   */
  async sendTransaction({
    instruction,
    signer,
    extraSigners = [],
  }: {
    instruction: TransactionInstruction;
    signer: UniversalSigner;
    extraSigners?: Keypair[];
  }): Promise<string> {
    const connection = this.connections[this.currentConnectionIndex];
    const feePayer = new PublicKey(signer.account.address);

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash('finalized');

    const tx = new Transaction({
      feePayer,
      blockhash,
      lastValidBlockHeight,
    }).add(instruction);

    if (extraSigners.length > 0) {
      tx.partialSign(...extraSigners);
    }

    const txBytes = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    if (!signer.signAndSendTransaction) {
      throw new Error('signer.signTransaction is undefined');
    }

    const txHashBytes = await signer.signAndSendTransaction(txBytes);

    return utils.bytes.bs58.encode(txHashBytes); // Clean, readable tx hash
  }

  /**
   * Waits for a transaction to be confirmed on the blockchain.
   */
  async confirmTransaction(signature: string, timeout = 30000): Promise<void> {
    const startTime = Date.now();

    return this.executeWithFallback(async (connection) => {
      while (Date.now() - startTime < timeout) {
        const status = await connection.getSignatureStatus(signature);
        if (status?.value) {
          if (status.value.err) {
            throw new Error(
              `Transaction failed: ${JSON.stringify(status.value.err)}`
            );
          }
          if (
            status.value.confirmationStatus === 'confirmed' ||
            status.value.confirmationStatus === 'finalized'
          ) {
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(`Transaction confirmation timeout after ${timeout}ms`);
    }, 'confirmTransaction');
  }

  /**
   * Estimates the fee (in lamports) to send a transaction with the given instructions.
   */
  async estimateGas({
    instructions,
    signer,
  }: {
    instructions: TransactionInstruction[];
    signer: UniversalSigner;
  }): Promise<bigint> {
    return this.executeWithFallback(async (connection) => {
      const feePayer = new PublicKey(signer.account.address);
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash();
      const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer });
      if (instructions.length) tx.add(...instructions);
      const message = tx.compileMessage();
      const feeResp = await connection.getFeeForMessage(message);
      if (!feeResp?.value) throw new Error('Failed to estimate fee');
      return BigInt(feeResp.value);
    }, 'estimateGas');
  }

  /**
   * Sleeps for the given number of milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Waits for a Solana transaction to reach the desired confirmations.
   *
   * @param txSignature   - The transaction signature to monitor
   * @param confirmations - Desired confirmation count (default: 6)
   * @param timeoutMs     - Max wait time in milliseconds (default: 90_000)
   * @param pollIntervalMs- How often to poll in milliseconds (default: 500)
   */
  async waitForConfirmations({
    txSignature,
    confirmations = 3,
    timeoutMs = 30000,
    pollIntervalMs = 500,
  }: {
    txSignature: string;
    confirmations?: number;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }): Promise<void> {
    const connection = this.connections[this.currentConnectionIndex];

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // fetch status
      const { value } = await connection.getSignatureStatuses([txSignature]);
      const status = value[0];

      if (
        status?.confirmations != null &&
        status.confirmations >= confirmations
      ) {
        return;
      }

      // wait before retrying
      await this.sleep(pollIntervalMs);
    }

    throw new Error(
      `Timeout: transaction ${txSignature} not confirmed with ` +
        `${confirmations} confirmations within ${timeoutMs} ms`
    );
  }
}
