import { ccc } from "@ckb-ccc/core";

const RPC_URL =
    process.env.NEXT_PUBLIC_CKB_RPC_URL ?? "https://testnet.ckb.dev/rpc";

/**
 * Read the total CKB balance (in CKB, not Shannon) of a CKB address.
 *
 * Uses a direct JSON-RPC call to `get_cells_capacity` — the standard CKB
 * indexer method — so it works regardless of which CCC client version is
 * installed and avoids any method-name uncertainty.
 *
 * Returns 0 on any network / parse error.
 */
export async function getAddressBalanceCKB(address: string): Promise<number> {
    try {
        // Derive the lock script from the address (pure computation, no network)
        const client = new ccc.ClientPublicTestnet();
        const addr = await ccc.Address.fromString(address, client);
        const script = addr.script;

        // Call the CKB indexer RPC directly
        const res = await fetch(RPC_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                id: 1,
                jsonrpc: "2.0",
                method: "get_cells_capacity",
                params: [
                    {
                        script: {
                            code_hash: script.codeHash,
                            hash_type: script.hashType,
                            args: script.args,
                        },
                        script_type: "lock",
                    },
                ],
            }),
        });

        const json = await res.json();
        // result.capacity is a hex string in Shannon
        const capacityHex: string = json?.result?.capacity ?? "0x0";
        const shannon = BigInt(capacityHex);
        // 1 CKB = 10^8 Shannon
        return Number(shannon) / 1e8;
    } catch {
        return 0;
    }
}
