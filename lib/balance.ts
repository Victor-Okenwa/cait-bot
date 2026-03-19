import { ccc } from "@ckb-ccc/core";

const SHANNON_PER_CKB = 100_000_000n;

/**
 * Read the total CKB balance of a CKB address by summing all live cell
 * capacities with that lock script via the CCC indexer client.
 *
 * Returns the balance in CKB (not Shannon).
 * Returns 0 on any error (address not funded, RPC down, etc.).
 */
export async function getAddressBalanceCKB(address: string): Promise<number> {
    try {
        const client = new ccc.ClientPublicTestnet();
        const addr = await ccc.Address.fromString(address, client);
        // client.getBalance sums capacity of all live cells with this lock script
        const balanceShannon: bigint = await client.getBalance([addr.script]);
        // Convert Shannon → CKB (floating point)
        return Number(balanceShannon) / Number(SHANNON_PER_CKB);
    } catch {
        return 0;
    }
}
