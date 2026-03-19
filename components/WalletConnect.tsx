"use client";


import { ccc } from "@ckb-ccc/connector-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Wallet, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { truncateAddress, formatBalance } from "@/utils/stringUtils";

export default function WalletConnect() {
    const { open, wallet } = ccc.useCcc();
    const signer = ccc.useSigner();
    const [address, setAddress] = useState<string>("");
    const [balance, setBalance] = useState<string>("");
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!signer) {
            setAddress("");
            setBalance("");
            return;
        }

        setLoading(true);
        Promise.all([
            signer.getRecommendedAddress(),
            signer.getBalance(),
        ])
            .then(([addr, capacity]) => {
                setAddress(addr);
                setBalance(formatBalance(ccc.fixedPointToString(capacity)));
            })
            .catch(console.error)
            .finally(() => setLoading(false));
    }, [signer]);

    if (!wallet) {
        return (
            <Button
                onClick={open}
                className="bg-cyan-600 hover:bg-cyan-500 text-white font-semibold gap-2"
            >
                <Wallet className="w-4 h-4" />
                Connect Wallet
            </Button>
        );
    }

    return (
        <button
            onClick={open}
            className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 transition px-4 py-2"
        >
            {loading ? (
                <Loader2 className="w-4 h-4 animate-spin text-cyan-400" />
            ) : (
                <img
                    src={wallet.icon}
                    alt={wallet.name}
                    className="w-6 h-6 rounded-full"
                />
            )}
            <div className="text-left">
                <p className="text-sm font-semibold text-white leading-none">
                    {balance} CKB
                </p>
                <p className="text-xs text-white/50 mt-0.5">
                    {truncateAddress(address, 10, 6)}
                </p>
            </div>
            <Badge
                variant="outline"
                className="ml-1 text-cyan-400 border-cyan-400/40 text-[10px]"
            >
                Testnet
            </Badge>
        </button>
    );
}