export type PricePoint = {
    timestamp: number; // Unix ms
    price: number;     // CKB price in USD                                     
};

// In-memory rolling buffer — last 30 data points                            
const priceHistory: PricePoint[] = [];
const MAX_HISTORY = 30;

// Retry with exponential backoff — handles CoinGecko rate limits (429)
async function fetchWithRetry(
    url: string,
    maxAttempts = 3,
    baseDelayMs = 2000
): Promise<Response> {
    let lastErr: Error = new Error("Unknown error");
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const res = await fetch(url, { cache: "no-store" });
            if (res.status === 429 || res.status >= 500) {
                lastErr = new Error(`CoinGecko ${res.status}`);
                if (i < maxAttempts - 1) {
                    await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, i)));
                    continue;
                }
            }
            return res;
        } catch (e: unknown) {
            lastErr = e as Error;
            if (i < maxAttempts - 1) {
                await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, i)));
            }
        }
    }
    throw lastErr;
}

export async function fetchCKBPrice(): Promise<number> {
    const res = await fetchWithRetry(
        "https://api.coingecko.com/api/v3/simple/price?ids=nervos-network&vs_currencies=usd"
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