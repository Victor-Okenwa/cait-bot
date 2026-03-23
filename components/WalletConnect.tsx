"use client";


import { ccc } from "@ckb-ccc/connector-react";
import { Button } from "@/components/ui/button";
import { Wallet, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { truncateAddress, formatBalance } from "@/utils/stringUtils";

export default function WalletConnect() {
    const { open, wallet } = ccc.useCcc();
    const signer = ccc.useSigner();
    const [address, setAddress] = useState<string>("");
    const [balance, setBalance] = useState<string>("");
    const [loading, setLoading] = useState(false);

    async function refreshBalance() {
        if (!signer) return;
        setLoading(true);
        try {
            const [addr, capacity] = await Promise.all([
                signer.getRecommendedAddress(),
                signer.getBalance(),
            ]);
            setAddress(addr);
            setBalance(formatBalance(ccc.fixedPointToString(capacity)));
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        refreshBalance();
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
        <div className="flex items-center gap-1">
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
            </button>
            <button
                onClick={refreshBalance}
                disabled={loading}
                title="Refresh balance"
                className="flex items-center justify-center w-8 h-8 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-white/50 hover:text-white transition-colors disabled:opacity-40"
            >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
        </div>
    );
}