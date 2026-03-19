import { ccc } from "@ckb-ccc/core";

const CKB_RPC_URL =
    process.env.NEXT_PUBLIC_CKB_RPC_URL ?? "https://testnet.ckb.dev/rpc";

const EXPLORER_BASE = "https://testnet.explorer.nervos.org/transaction";

export type SendResult = {
    txHash: string;
    explorerLink: string;
};

/**                                                                                                                            
 * Build and send a CKB testnet transfer with a memo comment.
 * Used by the agent to simulate buy/sell actions on-chain.                                                                    
 *                                                                                                                             
 * @param signer   - CCC signer from the connected wallet                                                                      
 * @param toAddress - recipient address (can be same wallet for self-transfer simulation)                                      
 * @param amountCKB - amount in CKB (will be converted to shannon: 1 CKB = 10^8 shannon)                                       
 * @param memo      - e.g. "CAIT BUY 500 CKB @ $0.012345"                                                                      
 */
export async function sendCKBWithMemo(
    signer: ccc.Signer,
    toAddress: string,
    amountCKB: number,
    memo: string
): Promise<SendResult> {
    const toScript = await ccc.Address.fromString(toAddress, signer.client);

    // Minimum cell capacity is 61 CKB; enforce a safe floor                                                                     
    const safeCKB = Math.max(amountCKB, 61);
    const amountShannon = ccc.fixedPointFrom(safeCKB.toFixed(8));

    const tx = ccc.Transaction.from({
        outputs: [
            {
                capacity: amountShannon,
                lock: toScript.script,
            },
        ],
        // Encode memo as UTF-8 hex in outputsData[0]
        outputsData: [stringToHex(memo)],
    });

    // Include cells with output data (CAIT BUY/SELL/DEPOSIT memos) — the
    // default filter only matches data-free cells, so those memos would be
    // invisible and the transaction would fail with "Insufficient CKB".
    const cellFilter = { outputDataLenRange: [0, 0xffffffff] as [number, number] };
    await tx.completeInputsByCapacity(signer, undefined, cellFilter);
    await tx.completeFeeBy(signer, 1000, cellFilter); // 1000 shannons/KB fee rate

    const txHash = await signer.sendTransaction(tx);

    return {
        txHash,
        explorerLink: `${EXPLORER_BASE}/${txHash}`,
    };
}

/**                                                                                                                            
 * Build a server-side CCC client (no wallet — read-only RPC queries).
 */
export function buildTestnetClient(): ccc.ClientPublicTestnet {
    return new ccc.ClientPublicTestnet();
}

/**                                                                                                                            
 * Convert a UTF-8 string to 0x-prefixed hex (for CKB outputsData memo).
 */
function stringToHex(str: string): string {
    const bytes = new TextEncoder().encode(str);
    const hex = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    return `0x${hex}`;
}    