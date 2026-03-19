export type PricePoint = {
    timestamp: number; // Unix ms
    price: number;     // CKB price in USD                                     
};

// In-memory rolling buffer — last 30 data points                            
const priceHistory: PricePoint[] = [];
const MAX_HISTORY = 30;

export async function fetchCKBPrice(): Promise<number> {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=nervos-network&vs_currencies=usd",
      { cache: "no-store" }
    );

    if (!res.ok) {
        throw new Error(`CoinGecko fetch failed: ${res.status}`);
    }

    const data = await res.json();
    const price: number = data?.["nervos-network"]?.usd;

    if (!price) {
        throw new Error("CoinGecko returned no price for nervos-network");
    }

    return price;
}

export async function fetchAndRecordPrice(): Promise<PricePoint> {
    const price = await fetchCKBPrice();
    const point: PricePoint = { timestamp: Date.now(), price };

    priceHistory.push(point);
    if (priceHistory.length > MAX_HISTORY) {
        priceHistory.shift();
    }

    return point;
}

export function getPriceHistory(): PricePoint[] {
    return [...priceHistory];
}    